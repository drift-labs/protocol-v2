import { ConfirmationStrategy, TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	Connection,
	SendTransactionError,
	Signer,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import { BaseTxSender } from './baseTxSender';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

const DEFAULT_RETRY = 2000;

type ResolveReference = {
	resolve?: () => void;
};

/**
 * `TxSender` that (like `RetryTxSender`) resends the same signed transaction to `connection`
 * every `retrySleep` ms until confirmation or timeout, additionally recording each in-flight
 * signature's blockhash/`lastValidBlockHeight` in `untilValid` and detecting solana-core's
 * blockhash-height-offset behavior via `useBlockHeightOffset`. Note: as currently implemented,
 * `sendRawTransaction`'s resend/timeout loop uses the same wall-clock `this.timeout` as
 * `RetryTxSender` and does not itself consult `untilValid`/`useBlockHeightOffset` to stop
 * resending once a transaction's blockhash has actually expired — those fields are populated for
 * callers/subclasses that want to inspect per-transaction validity, not consumed internally here.
 * Prefer this sender when you build transactions via this class's `prepareTx`/`sendVersionedTransaction`
 * (which populate `untilValid`) and need that bookkeeping available.
 */
export class WhileValidTxSender extends BaseTxSender {
	/** Interval (ms) between resend attempts of the same signed transaction. */
	retrySleep: number;
	timoutCount = 0;
	/** Tracks each currently in-flight transaction signature's blockhash and `lastValidBlockHeight`, populated by `prepareTx`/`sendVersionedTransaction` and cleared once `sendRawTransaction` finishes. */
	untilValid = new Map<
		string,
		{ blockhash: string; lastValidBlockHeight: number }
	>();

	/** Whether the connected cluster's solana-core version (`< 2`) requires the legacy block-height offset when checking blockhash validity; refreshed asynchronously by `checkAndSetUseBlockHeightOffset`. */
	useBlockHeightOffset = true;

	/**
	 * Queries `connection.getVersion()` and sets `useBlockHeightOffset` based on the cluster's
	 * solana-core major version (`true` for `< 2`, `false` for `>= 2`). Fire-and-forget: errors
	 * and unparseable versions are silently ignored, leaving `useBlockHeightOffset` at its current value.
	 */
	private async checkAndSetUseBlockHeightOffset() {
		this.connection.getVersion().then((version) => {
			const solanaCoreVersion = version['solana-core'];

			if (!solanaCoreVersion) return;

			const majorVersion = solanaCoreVersion.split('.')[0];

			if (!majorVersion) return;

			const parsedMajorVersion = parseInt(majorVersion);

			if (isNaN(parsedMajorVersion)) return;

			if (parsedMajorVersion >= 2) {
				this.useBlockHeightOffset = false;
			} else {
				this.useBlockHeightOffset = true;
			}
		});
	}

	/**
	 * @param props.connection - RPC connection used for sending, resending, and confirming.
	 * @param props.wallet - Wallet used to sign transactions that aren't already `preSigned`.
	 * @param props.opts - Default `ConfirmOptions`; defaults to `DEFAULT_CONFIRMATION_OPTS` with `maxRetries: 0` (retries are handled by this sender's own resend loop, not the RPC node).
	 * @param props.retrySleep - Interval (ms) between resend attempts; defaults to 2000 (2s).
	 * @param props.additionalConnections - Extra connections to also (re)broadcast raw transactions to.
	 * @param props.confirmationStrategy - How to wait for confirmation; defaults to `ConfirmationStrategy.Combo`.
	 * @param props.additionalTxSenderCallbacks - Callbacks invoked with each (re)sent transaction's base58 encoding.
	 * @param props.txHandler - Custom `TxHandler` for signing/building transactions.
	 * @param props.trackTxLandRate - Enables land-rate tracking.
	 * @param props.txLandRateLookbackWindowMinutes - Rolling window, in minutes, for the land-rate calculation.
	 * @param props.landRateToFeeFunc - Custom mapping from land rate to priority-fee multiplier.
	 * @param props.throwOnTimeoutError - Whether confirmation timeouts throw `TxSendError`; defaults to `true`.
	 * @param props.throwOnTransactionError - Whether a failed on-chain result throws; defaults to `true`.
	 */
	public constructor({
		connection,
		wallet,
		opts = { ...DEFAULT_CONFIRMATION_OPTS, maxRetries: 0 },
		retrySleep = DEFAULT_RETRY,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks = [],
		txHandler,
		trackTxLandRate,
		txLandRateLookbackWindowMinutes,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
		throwOnTransactionError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		retrySleep?: number;
		additionalConnections?: Connection[];
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		confirmationStrategy?: ConfirmationStrategy;
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
		throwOnTimeoutError?: boolean;
		throwOnTransactionError?: boolean;
	}) {
		super({
			connection,
			wallet,
			opts,
			additionalConnections,
			additionalTxSenderCallbacks,
			txHandler,
			trackTxLandRate,
			txLandRateLookbackWindowMinutes,
			confirmationStrategy,
			landRateToFeeFunc,
			throwOnTimeoutError,
			throwOnTransactionError,
		});
		this.retrySleep = retrySleep;

		this.checkAndSetUseBlockHeightOffset();
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
	 * Prepares (blockhash + signs, unless `preSigned`) a legacy `Transaction` using a fresh
	 * blockhash from `txHandler.getLatestBlockhashForTransaction()` (rather than `BaseTxSender`'s
	 * `prepareTx`, which would resolve one via `TxHandler.prepareTx`'s own path), and records the
	 * resulting signature's blockhash/expiry in `untilValid`.
	 * @param tx - Transaction to prepare.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param opts - Confirmation options passed through to `TxHandler.prepareTx`.
	 * @param preSigned - If `true`, skip signing; if the transaction carries a
	 * `SIGNATURE_BLOCK_AND_EXPIRY` marker (see `TxHandler`), that blockhash is used for `untilValid`
	 * instead of a freshly fetched one.
	 * @returns The prepared (and signed, unless `preSigned`) transaction.
	 * @throws Error if a blockhash can't be fetched/resolved, or the (pre)signed transaction has no signature.
	 */
	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions,
		preSigned?: boolean
	): Promise<Transaction> {
		let latestBlockhash =
			await this.txHandler.getLatestBlockhashForTransaction();

		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to fetch latest blockhash for transaction'
			);
		}

		// handle tx
		let signedTx = tx;
		if (!preSigned) {
			signedTx = await this.txHandler.prepareTx(
				tx,
				additionalSigners,
				undefined,
				opts,
				false,
				latestBlockhash
			);
		}

		// See SIGNATURE_BLOCK_AND_EXPIRY explanation in txHandler.ts if this is confusing
		// @ts-ignore
		if (preSigned && tx.SIGNATURE_BLOCK_AND_EXPIRY) {
			// @ts-ignore
			latestBlockhash = tx.SIGNATURE_BLOCK_AND_EXPIRY;
		}

		// handle subclass-specific side effects
		const signature = signedTx?.signature || signedTx.signatures[0]?.signature;
		if (!signature) {
			throw new Error(
				'WhileValidTxSender: signed transaction is missing a signature'
			);
		}
		const txSig = bs58.encode(signature);
		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to resolve latest blockhash for transaction'
			);
		}
		this.untilValid.set(txSig, latestBlockhash);

		return signedTx;
	}

	/**
	 * Signs (unless `preSigned`) and sends a `VersionedTransaction`, always overwriting its
	 * `recentBlockhash` with a freshly fetched one first (unless `preSigned` with a
	 * `SIGNATURE_BLOCK_AND_EXPIRY` marker, in which case that recorded blockhash is used for
	 * `untilValid` instead) — records the signature's blockhash/expiry in `untilValid` before
	 * delegating to `sendRawTransaction`.
	 * @param tx - Transaction to send; mutated in place (blockhash, signatures) unless `preSigned`.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param opts - Confirmation options; defaults to `this.opts`.
	 * @param preSigned - If `true`, skip signing (blockhash/`untilValid` bookkeeping still applies).
	 * @returns The result of `sendRawTransaction` on the serialized, signed transaction.
	 * @throws Error if a blockhash can't be fetched/resolved, or the (pre)signed transaction has no signature.
	 */
	async sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		let latestBlockhash =
			await this.txHandler.getLatestBlockhashForTransaction();

		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to fetch latest blockhash for transaction'
			);
		}

		let signedTx;
		if (preSigned) {
			signedTx = tx;

			// See SIGNATURE_BLOCK_AND_EXPIRY explanation in txHandler.ts if this is confusing
			// @ts-ignore
			if (tx.SIGNATURE_BLOCK_AND_EXPIRY) {
				// @ts-ignore
				latestBlockhash = tx.SIGNATURE_BLOCK_AND_EXPIRY;
			}

			// @ts-ignore
		} else if (this.wallet.payer) {
			tx.message.recentBlockhash = latestBlockhash.blockhash;
			// @ts-ignore
			tx.sign((additionalSigners ?? []).concat(this.wallet.payer));
			signedTx = tx;
		} else {
			tx.message.recentBlockhash = latestBlockhash.blockhash;
			additionalSigners
				?.filter((s): s is Signer => s !== undefined)
				.forEach((kp) => {
					tx.sign([kp]);
				});
			signedTx = await this.txHandler.signVersionedTx(
				tx,
				additionalSigners ?? [],
				latestBlockhash
			);
		}

		if (opts === undefined) {
			opts = this.opts;
		}

		const signature = signedTx.signatures[0];
		if (!signature) {
			throw new Error(
				'WhileValidTxSender: signed transaction is missing a signature'
			);
		}
		const txSig = bs58.encode(signature);
		if (!latestBlockhash) {
			throw new Error(
				'WhileValidTxSender: failed to resolve latest blockhash for transaction'
			);
		}
		this.untilValid.set(txSig, latestBlockhash);

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	/**
	 * Sends a raw transaction, then repeatedly resends the identical signed bytes to `connection`
	 * (and broadcasts to `additionalConnections`/`additionalTxSenderCallbacks`) every `retrySleep`
	 * ms while concurrently waiting for confirmation, like `RetryTxSender`. Additionally: if
	 * confirmation resolves with an on-chain error and `checkConfirmationResultForError` doesn't
	 * itself throw (e.g. the detailed error couldn't be resolved), throws a generic
	 * `SendTransactionError` as a fallback when `throwOnTransactionError` is set; and always removes
	 * `txid` from `untilValid` once done, regardless of outcome.
	 * @param rawTransaction - Serialized, signed transaction bytes.
	 * @param opts - Options passed to each send/resend and to confirmation; `opts.commitment` selects confirmation level.
	 * @returns The signature and confirmation slot once confirmed.
	 * @throws Whatever `confirmTransaction` or `checkConfirmationResultForError` throw, or the
	 * fallback `SendTransactionError` described above.
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

				if (result.value?.err && this.throwOnTransactionError) {
					// Fallback error handling if there's a problem reporting the error in checkConfirmationResultForError
					throw new SendTransactionError({
						action: 'send',
						signature: txid,
						transactionMessage: `Transaction Failed`,
					});
				}

				slot = result.context.slot;
			}
			// eslint-disable-next-line no-useless-catch
		} catch (e) {
			throw e;
		} finally {
			stopWaiting();
			this.untilValid.delete(txid);
		}

		return { txSig: txid, slot };
	}
}
