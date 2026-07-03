import { ConfirmationStrategy, TxSigAndSlot } from './types';
import { ConfirmOptions, Connection } from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 2000;

type ResolveReference = {
	resolve?: () => void;
};

/**
 * Default `TxSender` for most clients: sends a transaction once, then keeps resending the exact
 * same signed bytes (to `connection` and every `additionalConnections` entry) every `retrySleep`
 * ms until it confirms or `timeout` elapses. This is client-side resend, independent of the RPC
 * node's own forwarding — useful when relying on rebroadcast to improve inclusion odds under
 * congestion, at the cost of extra RPC load compared to `FastSingleTxSender`.
 */
export class RetryTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	/** Interval (ms) between resend attempts of the same signed transaction. */
	retrySleep: number;
	additionalConnections: Connection[];
	timoutCount = 0;

	/**
	 * @param props.connection - RPC connection used for sending, resending, and confirming.
	 * @param props.wallet - Wallet used to sign transactions that aren't already `preSigned`.
	 * @param props.opts - Default `ConfirmOptions`; defaults to `DEFAULT_CONFIRMATION_OPTS` with `maxRetries: 0` (retries are handled by this sender's own resend loop, not the RPC node).
	 * @param props.timeout - Total time (ms) to keep resending and waiting for confirmation before giving up; defaults to 35000 (35s).
	 * @param props.retrySleep - Interval (ms) between resend attempts; defaults to 2000 (2s).
	 * @param props.additionalConnections - Extra connections to also (re)broadcast raw transactions to.
	 * @param props.confirmationStrategy - How to wait for confirmation; defaults to `ConfirmationStrategy.Combo`.
	 * @param props.additionalTxSenderCallbacks - Callbacks invoked with each (re)sent transaction's base58 encoding.
	 * @param props.txHandler - Custom `TxHandler` for signing/building transactions.
	 * @param props.trackTxLandRate - Enables land-rate tracking.
	 * @param props.txLandRateLookbackWindowMinutes - Rolling window, in minutes, for the land-rate calculation.
	 * @param props.landRateToFeeFunc - Custom mapping from land rate to priority-fee multiplier.
	 * @param props.throwOnTimeoutError - Whether confirmation timeouts throw `TxSendError`; defaults to `true`.
	 */
	public constructor({
		connection,
		wallet,
		opts = { ...DEFAULT_CONFIRMATION_OPTS, maxRetries: 0 },
		timeout = DEFAULT_TIMEOUT,
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks = [],
		txHandler,
		trackTxLandRate,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		retrySleep?: number;
		additionalConnections?: Connection[];
		confirmationStrategy?: ConfirmationStrategy;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
		throwOnTimeoutError?: boolean;
	}) {
		super({
			connection,
			wallet,
			opts,
			timeout,
			additionalConnections,
			confirmationStrategy,
			additionalTxSenderCallbacks,
			txHandler,
			trackTxLandRate,
			txLandRateLookbackWindowMinutes,
			landRateToFeeFunc,
			throwOnTimeoutError,
		});
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.retrySleep = retrySleep;
		this.additionalConnections = additionalConnections;
	}

	/**
	 * Waits `retrySleep` milliseconds, exposing an early-wake `resolve` via `reference` so the
	 * resend loop in `sendRawTransaction` can stop promptly once the transaction confirms or a
	 * resend fails.
	 * @param reference - Mutable holder `sendRawTransaction` uses to resolve this sleep early.
	 */
	async sleep(reference: ResolveReference): Promise<void> {
		return new Promise((resolve) => {
			reference.resolve = resolve;
			setTimeout(resolve, this.retrySleep);
		});
	}

	/**
	 * Sends a raw transaction, then repeatedly resends the identical signed bytes to `connection`
	 * (and broadcasts to `additionalConnections`/`additionalTxSenderCallbacks`) every `retrySleep`
	 * ms while concurrently waiting for confirmation. The resend loop stops as soon as
	 * confirmation resolves, a resend attempt itself throws, or `timeout` elapses.
	 * @param rawTransaction - Serialized, signed transaction bytes.
	 * @param opts - Options passed to each send/resend and to confirmation; `opts.commitment` selects confirmation level.
	 * @returns The signature and confirmation slot once confirmed.
	 * @throws Whatever `confirmTransaction` or `checkConfirmationResultForError` throw (e.g.
	 * `TxSendError` on timeout, or the resolved on-chain error for a failed transaction).
	 */
	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		const startTime = this.getTimestamp();

		const txid = await this.connection.sendRawTransaction(rawTransaction, opts);
		this.txSigCache?.set(txid, false);
		this.sendToAdditionalConnections(rawTransaction, opts);

		let done = false;
		const resolveReference: ResolveReference = {
			resolve: undefined,
		};
		const stopWaiting = () => {
			done = true;
			if (resolveReference.resolve) {
				resolveReference.resolve();
			}
		};

		(async () => {
			while (!done && this.getTimestamp() - startTime < this.timeout) {
				await this.sleep(resolveReference);
				if (!done) {
					this.connection
						.sendRawTransaction(rawTransaction, opts)
						.catch((e) => {
							console.error(e);
							stopWaiting();
						});
					this.sendToAdditionalConnections(rawTransaction, opts);
				}
			}
		})();

		let slot: number | undefined;
		try {
			const result = await this.confirmTransaction(txid, opts.commitment);
			this.txSigCache?.set(txid, true);

			if (result) {
				await this.checkConfirmationResultForError(txid, result.value);

				slot = result.context?.slot;
			}
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: txid, slot };
	}
}
