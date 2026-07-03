import { ConfirmationStrategy, TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	TransactionSignature,
	Connection,
	Commitment,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_BLOCKHASH_REFRESH = 10000;

/**
 * `TxSender` optimized for low latency: sends a transaction exactly once (no resend/retry loop —
 * relies on the RPC node's own forwarding), and can skip confirmation entirely or confirm
 * asynchronously in the background so `sendRawTransaction` returns as soon as the send lands.
 * Maintains its own periodically-refreshed blockhash cache (independent of `TxHandler`'s) purely
 * for that background-refresh convenience; it is not actually consumed by `sendRawTransaction`
 * here. Suited to latency-sensitive keeper bots that would rather fire-and-forget than pay for
 * `RetryTxSender`'s resend loop.
 */
export class FastSingleTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	/** How often (ms) `startBlockhashRefreshLoop` refreshes `recentBlockhash`; `0` disables the refresh loop. */
	blockhashRefreshInterval: number;
	additionalConnections: Connection[];
	timoutCount = 0;
	/** Periodically refreshed blockhash cache (see `startBlockhashRefreshLoop`); informational only — `sendRawTransaction` does not currently read this field. */
	recentBlockhash?: BlockhashWithExpiryBlockHeight;
	/** If `true`, `sendRawTransaction` returns immediately after sending, without waiting for or checking confirmation. */
	skipConfirmation: boolean;
	/** If `true` (and `skipConfirmation` is `false`), confirmation runs without being awaited — `sendRawTransaction` returns before the transaction is confirmed. */
	confirmInBackground: boolean;
	/** Commitment level used when refreshing `recentBlockhash`. */
	blockhashCommitment: Commitment;
	/** Handle for the interval timer started by `startBlockhashRefreshLoop`. */
	blockhashIntervalId?: NodeJS.Timer;

	/**
	 * @param props.connection - RPC connection used for sending, confirming, and blockhash refresh.
	 * @param props.wallet - Wallet used to sign transactions that aren't already `preSigned`.
	 * @param props.opts - Default `ConfirmOptions`; defaults to `DEFAULT_CONFIRMATION_OPTS` with `maxRetries: 0` (this sender does not retry sends itself).
	 * @param props.timeout - Confirmation timeout in milliseconds; defaults to 35000 (35s).
	 * @param props.blockhashRefreshInterval - Interval (ms) for the background blockhash refresh; defaults to 10000 (10s). `0` disables it.
	 * @param props.additionalConnections - Extra connections to also broadcast raw transactions to.
	 * @param props.skipConfirmation - Skip confirmation entirely after sending; defaults to `false`.
	 * @param props.confirmInBackground - Confirm without awaiting, so `sendRawTransaction` resolves right after send; defaults to `false`.
	 * @param props.blockhashCommitment - Commitment for the background blockhash refresh; defaults to `'finalized'`.
	 * @param props.confirmationStrategy - How to wait for confirmation; defaults to `ConfirmationStrategy.Combo`.
	 * @param props.trackTxLandRate - Enables land-rate tracking.
	 * @param props.txHandler - Custom `TxHandler` for signing/building transactions.
	 * @param props.txLandRateLookbackWindowMinutes - Rolling window, in minutes, for the land-rate calculation.
	 * @param props.landRateToFeeFunc - Custom mapping from land rate to priority-fee multiplier.
	 * @param props.throwOnTimeoutError - Whether confirmation timeouts throw `TxSendError`; defaults to `true`.
	 */
	public constructor({
		connection,
		wallet,
		opts = { ...DEFAULT_CONFIRMATION_OPTS, maxRetries: 0 },
		timeout = DEFAULT_TIMEOUT,
		blockhashRefreshInterval = DEFAULT_BLOCKHASH_REFRESH,
		additionalConnections = new Array<Connection>(),
		skipConfirmation = false,
		confirmInBackground = false,
		blockhashCommitment = 'finalized',
		confirmationStrategy = ConfirmationStrategy.Combo,
		trackTxLandRate,
		txHandler,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		blockhashRefreshInterval?: number;
		additionalConnections?: Connection[];
		skipConfirmation?: boolean;
		confirmInBackground?: boolean;
		blockhashCommitment?: Commitment;
		confirmationStrategy?: ConfirmationStrategy;
		trackTxLandRate?: boolean;
		txHandler?: TxHandler;
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
		this.blockhashRefreshInterval = blockhashRefreshInterval;
		this.additionalConnections = additionalConnections;
		this.skipConfirmation = skipConfirmation;
		this.confirmInBackground = confirmInBackground;
		this.blockhashCommitment = blockhashCommitment;
		this.startBlockhashRefreshLoop();
	}

	/**
	 * Starts a `setInterval` loop (if `blockhashRefreshInterval > 0`) that refreshes
	 * `this.recentBlockhash` every `blockhashRefreshInterval` ms. Fetch errors are logged and
	 * otherwise ignored (the loop keeps running with the stale cached value).
	 */
	startBlockhashRefreshLoop(): void {
		if (this.blockhashRefreshInterval > 0) {
			this.blockhashIntervalId = setInterval(async () => {
				try {
					this.recentBlockhash = await this.connection.getLatestBlockhash(
						this.blockhashCommitment
					);
				} catch (e) {
					console.error('Error in startBlockhashRefreshLoop: ', e);
				}
			}, this.blockhashRefreshInterval);
		}
	}

	/**
	 * Sends a raw transaction exactly once via `connection.sendRawTransaction` (plus a best-effort
	 * broadcast to `additionalConnections`), then confirms it unless `skipConfirmation` is set —
	 * awaited normally, or fired without awaiting if `confirmInBackground` is set (in which case
	 * the returned `slot` will be `undefined`, since it isn't known yet at return time).
	 * @param rawTransaction - Serialized, signed transaction bytes.
	 * @param opts - Options passed to `sendRawTransaction`/`confirmTransaction`; `opts.commitment` selects confirmation level.
	 * @returns The signature, and the confirmation slot if confirmation completed synchronously (`undefined` if `skipConfirmation` or `confirmInBackground` is set).
	 * @throws Whatever `connection.sendRawTransaction` or (if awaited) `confirmTransaction`/`checkConfirmationResultForError` throw.
	 */
	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		let txid: TransactionSignature;
		try {
			txid = await this.connection.sendRawTransaction(rawTransaction, opts);
			this.txSigCache?.set(txid, false);
			this.sendToAdditionalConnections(rawTransaction, opts);
		} catch (e) {
			console.error(e);
			throw e;
		}

		let slot: number | undefined;
		if (!this.skipConfirmation) {
			try {
				if (this.confirmInBackground) {
					this.confirmTransaction(txid, opts.commitment)
						.then(async (result) => {
							this.txSigCache?.set(txid, true);
							if (result) {
								await this.checkConfirmationResultForError(txid, result.value);
								slot = result.context.slot;
							}
						})
						.catch((err) => {
							// background confirmation is fire-and-forget; surface failures
							// in logs instead of as unhandled promise rejections
							console.error(
								`Error confirming transaction ${txid} in background:`,
								err
							);
						});
				} else {
					const result = await this.confirmTransaction(txid, opts.commitment);
					this.txSigCache?.set(txid, true);
					if (result) {
						await this.checkConfirmationResultForError(txid, result.value);
						slot = result.context.slot;
					}
				}
			} catch (e) {
				console.error(e);
				throw e;
			}
		}

		return { txSig: txid, slot };
	}
}
