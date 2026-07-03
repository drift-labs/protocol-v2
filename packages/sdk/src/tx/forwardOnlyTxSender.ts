import {
	ConfirmOptions,
	Connection,
	VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { BaseTxSender } from './baseTxSender';
import { ConfirmationStrategy, TxSigAndSlot } from './types';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRY = 5000;

type ResolveReference = {
	resolve?: () => void;
};

/**
 * `TxSender` that never calls `connection.sendRawTransaction` itself — instead it hands the raw
 * transaction to `additionalTxSenderCallbacks` (e.g. a Jito/third-party bundle submitter) and
 * re-invokes those callbacks on a `retrySleep` interval until the transaction confirms or
 * `timeout` elapses. `connection` is used only to *confirm* the transaction (via
 * `BaseTxSender.confirmTransaction`), never to broadcast it. `additionalConnections` is always
 * empty for this sender (the constructor doesn't accept it) since forwarding goes exclusively
 * through the callbacks.
 *
 * Use this when transaction submission is delegated to an external forwarder/relay rather than
 * this RPC connection, but you still want this SDK's confirmation/retry/land-rate machinery.
 */
export class ForwardOnlyTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	retrySleep: number;
	additionalConnections: Connection[];
	timoutCount = 0;

	/**
	 * @param props.connection - RPC connection used only for confirmation, never for sending.
	 * @param props.wallet - Wallet used to sign transactions that aren't already `preSigned`.
	 * @param props.opts - Default `ConfirmOptions`; defaults to `DEFAULT_CONFIRMATION_OPTS` with `maxRetries: 0` (retries are handled by this sender's own re-forward loop, not the RPC node).
	 * @param props.timeout - Total time (ms) to keep re-forwarding and waiting for confirmation before giving up; defaults to 35000 (35s).
	 * @param props.retrySleep - Interval (ms) between re-invocations of `additionalTxSenderCallbacks`; defaults to 5000 (5s).
	 * @param props.confirmationStrategy - How to wait for confirmation; defaults to `ConfirmationStrategy.Combo`.
	 * @param props.additionalTxSenderCallbacks - Callbacks that actually submit the transaction (e.g. to a relay/bundler); required for this sender to do anything, since it never calls `sendRawTransaction` on `connection` itself. Defaults to an empty array (transaction is never actually broadcast anywhere).
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
			additionalConnections: [],
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
		this.additionalConnections = [];
	}

	/**
	 * Waits `retrySleep` milliseconds, exposing an early-wake `resolve` via `reference` so
	 * `sendRawTransaction`'s stop condition can cut the wait short once the transaction confirms.
	 * @param reference - Mutable holder `sendRawTransaction` uses to resolve this sleep early.
	 */
	async sleep(reference: ResolveReference): Promise<void> {
		return new Promise((resolve) => {
			reference.resolve = resolve;
			setTimeout(resolve, this.retrySleep);
		});
	}

	/**
	 * Overrides `BaseTxSender.sendToAdditionalConnections` to skip `additionalConnections`
	 * entirely (always empty for this sender) and only invoke `additionalTxSenderCallbacks` with
	 * the base58-encoded transaction — this is this sender's *only* transaction submission path.
	 * @param rawTx - Serialized, signed transaction bytes.
	 * @param _opts - Unused (kept for `BaseTxSender` override compatibility).
	 */
	sendToAdditionalConnections(
		rawTx: Buffer | Uint8Array,
		_opts: ConfirmOptions
	): void {
		this.additionalTxSenderCallbacks?.map((callback) => {
			callback(bs58.encode(rawTx));
		});
	}

	/**
	 * "Sends" a raw transaction by repeatedly invoking `additionalTxSenderCallbacks` with it every
	 * `retrySleep` ms (never calling `connection.sendRawTransaction`) while concurrently waiting
	 * for confirmation via `confirmTransaction`. Re-forwarding stops as soon as confirmation
	 * resolves (successfully or by throwing) or `timeout` elapses.
	 * @param rawTransaction - Serialized, signed transaction bytes (must deserialize as a `VersionedTransaction`).
	 * @param opts - Confirmation options; `opts.commitment` is used for confirmation.
	 * @returns The signature and confirmation slot once confirmed.
	 * @throws Whatever `confirmTransaction` throws (e.g. `TxSendError` on timeout, or the resolved on-chain error).
	 */
	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		const deserializedTx = VersionedTransaction.deserialize(rawTransaction);

		const txSig = deserializedTx.signatures[0];
		const encodedTxSig = bs58.encode(txSig);

		const startTime = this.getTimestamp();

		this.sendToAdditionalConnections(rawTransaction, opts);
		this.txSigCache?.set(encodedTxSig, false);

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
					this.sendToAdditionalConnections(rawTransaction, opts);
				}
			}
		})();

		let slot: number | undefined;
		try {
			const result = await this.confirmTransaction(
				encodedTxSig,
				opts.commitment
			);
			slot = result?.context?.slot;
			this.txSigCache?.set(encodedTxSig, true);
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
		}

		return { txSig: encodedTxSig, slot };
	}
}
