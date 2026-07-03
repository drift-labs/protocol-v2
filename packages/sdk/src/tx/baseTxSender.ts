import {
	ConfirmationStrategy,
	TxSender,
	TxSendError,
	TxSigAndSlot,
} from './types';
import {
	Commitment,
	ConfirmOptions,
	Context,
	RpcResponseAndContext,
	Signer,
	SignatureResult,
	Transaction,
	TransactionSignature,
	Connection,
	VersionedTransaction,
	TransactionInstruction,
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import assert from 'assert';
import bs58 from 'bs58';
import { TxHandler } from './txHandler';
import { IWallet } from '../types';
import NodeCache from 'node-cache';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';
import { NOT_CONFIRMED_ERROR_CODE } from '../constants/txConstants';
import { throwTransactionError } from './reportTransactionError';

const BASELINE_TX_LAND_RATE = 0.9;
const DEFAULT_TIMEOUT = 35000;
const DEFAULT_TX_LAND_RATE_LOOKBACK_WINDOW_MINUTES = 10;

/**
 * Shared base for all `TxSender` implementations (`RetryTxSender`, `WhileValidTxSender`,
 * `FastSingleTxSender`, `ForwardOnlyTxSender`). Provides signing/serialization via `TxHandler`,
 * confirmation via websocket subscription and/or polling (per `ConfirmationStrategy`),
 * timeout/land-rate bookkeeping, and fan-out to `additionalConnections`. Subclasses are expected
 * to implement `sendRawTransaction` with their specific retry/broadcast behavior — the base
 * implementation always throws.
 */
export abstract class BaseTxSender implements TxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	/** Confirmation timeout in milliseconds, applied to both websocket and polling confirmation. */
	timeout: number;
	/** Extra RPC connections a raw transaction is also broadcast to (best-effort, errors logged not thrown), for redundancy. */
	additionalConnections: Connection[];
	/** Count of `confirmTransactionWebSocket`/`confirmTransactionPolling` calls that hit `timeout` without a definitive result. */
	timeoutCount = 0;
	confirmationStrategy: ConfirmationStrategy;
	/** Callbacks invoked with the base58-encoded raw transaction alongside `additionalConnections` broadcasts, e.g. for logging/mempool submission. */
	additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
	txHandler: TxHandler;
	/** Whether to record each sent signature (via `txSigCache`) to compute `getTxLandRate()`. */
	trackTxLandRate?: boolean;
	/** Whether `confirmTransactionWebSocket`/`confirmTransactionPolling` throw `TxSendError` on timeout (`true`) or return `undefined` (`false`). */
	throwOnTimeoutError: boolean;
	/** Whether `checkConfirmationResultForError` throws the resolved on-chain error, or is a no-op. */
	throwOnTransactionError: boolean;

	// For landing rate calcs
	/** Lookback window, in seconds, over which `txSigCache` entries expire for the land-rate calculation. */
	lookbackWindowMinutes: number;
	/** TTL cache of `txSig -> landed?` used to compute `getTxLandRate()` when `trackTxLandRate` is set. */
	txSigCache?: NodeCache;
	txLandRate = 0;
	lastPriorityFeeSuggestion = 1;
	/** Maps a land rate (0-1) to a priority-fee multiplier; defaults to `defaultLandRateToFeeFunc`. */
	landRateToFeeFunc: (landRate: number) => number;

	/**
	 * @param props.connection - Primary RPC connection used for sending and confirming transactions.
	 * @param props.wallet - Wallet used to sign transactions that aren't already `preSigned`.
	 * @param props.opts - Default `ConfirmOptions` used when a call site doesn't pass its own; defaults to `DEFAULT_CONFIRMATION_OPTS` (`'confirmed'`).
	 * @param props.timeout - Confirmation timeout in milliseconds; defaults to 35000 (35s).
	 * @param props.additionalConnections - Extra connections to also broadcast raw transactions to.
	 * @param props.confirmationStrategy - How to wait for confirmation; defaults to `ConfirmationStrategy.Combo`.
	 * @param props.additionalTxSenderCallbacks - Callbacks invoked with each sent transaction's base58 encoding.
	 * @param props.trackTxLandRate - Enables land-rate tracking (backs `getTxLandRate()`/`getSuggestedPriorityFeeMultiplier()`).
	 * @param props.txHandler - Custom `TxHandler` for signing/building transactions; defaults to one constructed from `connection`/`wallet`/`opts`.
	 * @param props.txLandRateLookbackWindowMinutes - Rolling window, in minutes, of sent signatures kept for the land-rate calculation; defaults to 10.
	 * @param props.landRateToFeeFunc - Custom mapping from land rate to priority-fee multiplier; defaults to `defaultLandRateToFeeFunc`.
	 * @param props.throwOnTimeoutError - Whether confirmation timeouts throw `TxSendError` instead of returning `undefined`; defaults to `true`.
	 * @param props.throwOnTransactionError - Whether a failed on-chain result throws the resolved program error; defaults to `true`.
	 */
	public constructor({
		connection,
		wallet,
		opts = DEFAULT_CONFIRMATION_OPTS,
		timeout = DEFAULT_TIMEOUT,
		additionalConnections = new Array<Connection>(),
		confirmationStrategy = ConfirmationStrategy.Combo,
		additionalTxSenderCallbacks,
		trackTxLandRate,
		txHandler,
		txLandRateLookbackWindowMinutes = DEFAULT_TX_LAND_RATE_LOOKBACK_WINDOW_MINUTES,
		landRateToFeeFunc,
		throwOnTimeoutError = true,
		throwOnTransactionError = true,
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		additionalConnections?: Connection[];
		confirmationStrategy?: ConfirmationStrategy;
		additionalTxSenderCallbacks?: ((base58EncodedTx: string) => void)[];
		txHandler?: TxHandler;
		trackTxLandRate?: boolean;
		txLandRateLookbackWindowMinutes?: number;
		landRateToFeeFunc?: (landRate: number) => number;
		throwOnTimeoutError?: boolean;
		throwOnTransactionError?: boolean;
	}) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.additionalConnections = additionalConnections;
		this.confirmationStrategy = confirmationStrategy;
		this.additionalTxSenderCallbacks = additionalTxSenderCallbacks;
		this.txHandler =
			txHandler ??
			new TxHandler({
				connection: this.connection,
				wallet: this.wallet,
				confirmationOptions: this.opts,
			});
		this.trackTxLandRate = trackTxLandRate;
		this.lookbackWindowMinutes = txLandRateLookbackWindowMinutes * 60;
		if (this.trackTxLandRate) {
			this.txSigCache = new NodeCache({
				stdTTL: this.lookbackWindowMinutes,
				checkperiod: 120,
			});
		}
		this.landRateToFeeFunc =
			landRateToFeeFunc ?? this.defaultLandRateToFeeFunc.bind(this);
		this.throwOnTimeoutError = throwOnTimeoutError;
		this.throwOnTransactionError = throwOnTransactionError;
	}

	/**
	 * Signs (via `prepareTx`, unless `preSigned`) and sends a legacy `Transaction`.
	 * @param tx - Transaction to send.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet; defaults to none.
	 * @param opts - Confirmation options; defaults to `this.opts`.
	 * @param preSigned - If `true`, skip wallet signing.
	 * @returns The result of `sendRawTransaction` on the serialized, signed transaction.
	 */
	async send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		const signedTx = await this.prepareTx(
			tx,
			additionalSigners,
			opts,
			preSigned
		);

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	/**
	 * Delegates to `TxHandler.prepareTx` to attach a recent blockhash, fee payer, and signatures.
	 * @param tx - Transaction to prepare.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param opts - Confirmation options (affects blockhash commitment).
	 * @param preSigned - If `true`, skip wallet signing.
	 * @returns The prepared (blockhash-populated, signed unless `preSigned`) transaction.
	 */
	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions,
		preSigned?: boolean
	): Promise<Transaction> {
		return this.txHandler.prepareTx(
			tx,
			additionalSigners,
			undefined,
			opts,
			preSigned
		);
	}

	/**
	 * Builds (but does not send) a `VersionedTransaction` from raw instructions via
	 * `TxHandler.generateVersionedTransaction`.
	 * @param ixs - Instructions to include, in order.
	 * @param lookupTableAccounts - Address lookup tables to compile the message against.
	 * @param _additionalSigners - Unused by this implementation.
	 * @param opts - Unused by this implementation (present for `TxSender` interface compatibility).
	 * @param blockhash - Blockhash to use; if omitted, fetched fresh via `connection.getLatestBlockhash()`.
	 * @returns The compiled `VersionedTransaction` (not yet signed by additional signers beyond the wallet).
	 */
	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		_additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		blockhash?: BlockhashWithExpiryBlockHeight
	): Promise<VersionedTransaction> {
		return this.txHandler.generateVersionedTransaction(
			blockhash ?? (await this.connection.getLatestBlockhash()),
			ixs,
			lookupTableAccounts,
			this.wallet
		);
	}

	/**
	 * Signs (unless `preSigned`) and sends a `VersionedTransaction`. When the wallet exposes a
	 * `payer` `Keypair` directly, signs in-place with `tx.sign(...)`; otherwise delegates to
	 * `TxHandler.signVersionedTx` (needed for wallet adapters without direct keypair access).
	 * @param tx - Transaction to send.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param opts - Confirmation options; defaults to `this.opts`.
	 * @param preSigned - If `true`, skip signing entirely.
	 * @returns The result of `sendRawTransaction` on the serialized, signed transaction.
	 */
	async sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		let signedTx;

		if (preSigned) {
			signedTx = tx;
			// @ts-ignore
		} else if (this.wallet.payer) {
			// @ts-ignore
			tx.sign((additionalSigners ?? []).concat(this.wallet.payer));
			signedTx = tx;
		} else {
			signedTx = await this.txHandler.signVersionedTx(
				tx,
				additionalSigners ?? [],
				undefined,
				this.wallet
			);
		}

		if (opts === undefined) {
			opts = this.opts;
		}

		return this.sendRawTransaction(signedTx.serialize(), opts);
	}

	/**
	 * Sends and confirms an already-serialized, already-signed transaction. `BaseTxSender` itself
	 * has no broadcast/retry strategy — every concrete sender (`RetryTxSender`,
	 * `WhileValidTxSender`, `FastSingleTxSender`, `ForwardOnlyTxSender`) must override this.
	 * @throws Error always, if not overridden by a subclass.
	 */
	async sendRawTransaction(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		rawTransaction: Buffer | Uint8Array,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		throw new Error('Must be implemented by subclass');
	}

	/**
	 * Simulates a transaction via `connection.simulateTransaction` without sending it, swallowing
	 * both simulation errors and RPC-call failures into a `false` result (logged to `console.error`).
	 * @param tx - Transaction to simulate.
	 * @returns `true` if simulation succeeded with no error, `false` otherwise.
	 */
	async simulateTransaction(tx: VersionedTransaction): Promise<boolean> {
		try {
			const result = await this.connection.simulateTransaction(tx);
			if (result.value.err != null) {
				console.error('Error in transaction simulation: ', result.value.err);
				return false;
			}
			return true;
		} catch (e) {
			console.error('Error calling simulateTransaction: ', e);
			return false;
		}
	}

	/**
	 * Waits for a transaction to confirm by subscribing to `onSignature` on `connection` and every
	 * `additionalConnections` entry simultaneously, resolving on whichever responds first. If no
	 * connection confirms within `this.timeout` and `confirmationStrategy` is `Combo`, falls back
	 * to a one-shot `getSignatureStatuses` check before giving up.
	 * @param signature - Base58-encoded transaction signature to confirm.
	 * @param commitment - Commitment level for the subscription; defaults to `this.opts.commitment`.
	 * @returns The confirmation result, or `undefined` if it timed out and `throwOnTimeoutError` is `false`.
	 * @throws Error if `signature` isn't valid base58 or isn't 64 bytes decoded. `TxSendError`
	 * (code `NOT_CONFIRMED_ERROR_CODE`) on timeout if `throwOnTimeoutError` is `true` (the default) —
	 * in that case the transaction's actual outcome is unknown, not necessarily failed.
	 */
	async confirmTransactionWebSocket(
		signature: TransactionSignature,
		commitment?: Commitment
	): Promise<RpcResponseAndContext<SignatureResult> | undefined> {
		let decodedSignature;
		try {
			decodedSignature = bs58.decode(signature);
		} catch (err) {
			throw new Error('signature must be base58 encoded: ' + signature);
		}

		assert(decodedSignature.length === 64, 'signature has invalid length');

		const start = Date.now();
		const subscriptionCommitment = commitment || this.opts.commitment;

		const subscriptionIds = new Array<number | undefined>();
		const connections = [this.connection, ...this.additionalConnections];
		let response: RpcResponseAndContext<SignatureResult> | null = null;
		const promises = connections.map((connection, i) => {
			let subscriptionId: number | undefined;
			// a failed subscription setup on one connection is best-effort: log and
			// leave its promise pending so the race keeps waiting on the others
			// (if every subscription fails, the timeout/Combo fallback still applies)
			const confirmPromise = new Promise((resolve) => {
				try {
					subscriptionId = connection.onSignature(
						signature,
						(result: SignatureResult, context: Context) => {
							subscriptionIds[i] = undefined;
							response = {
								context,
								value: result,
							};
							resolve(null);
						},
						subscriptionCommitment
					);
				} catch (err) {
					console.error(
						'confirmTransactionWebSocket: failed to set up onSignature listener',
						err
					);
				}
			});
			subscriptionIds.push(subscriptionId);
			return confirmPromise;
		});

		try {
			await this.promiseTimeout(promises, this.timeout);
		} finally {
			for (const [i, subscriptionId] of subscriptionIds.entries()) {
				if (subscriptionId) {
					connections[i].removeSignatureListener(subscriptionId);
				}
			}
		}

		if (response === null) {
			if (this.confirmationStrategy === ConfirmationStrategy.Combo) {
				try {
					const rpcResponse = await this.connection.getSignatureStatuses([
						signature,
					]);

					if (rpcResponse?.value?.[0]?.confirmationStatus) {
						response = {
							context: rpcResponse.context,
							value: { err: rpcResponse.value[0].err },
						};
						return response;
					}
				} catch (error) {
					// Ignore error to pass through to timeout error
				}
			}
			this.timeoutCount += 1;
			const duration = (Date.now() - start) / 1000;
			if (this.throwOnTimeoutError) {
				throw new TxSendError(
					`Transaction was not confirmed in ${duration.toFixed(
						2
					)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
					NOT_CONFIRMED_ERROR_CODE
				);
			}
		}

		return response ?? undefined;
	}

	/**
	 * Waits for a transaction to confirm by polling `getSignatureStatuses` with exponential
	 * backoff, starting at 400ms and capping at 5000ms, until `commitment` is reached or
	 * `this.timeout` elapses.
	 * @param signature - Base58-encoded transaction signature to confirm.
	 * @param commitment - Commitment level to wait for; defaults to `'finalized'`.
	 * @returns The confirmation result (`{ err: null }` on success), or `undefined` if it timed out and `throwOnTimeoutError` is `false`.
	 * @throws TxSendError (code `NOT_CONFIRMED_ERROR_CODE`) on timeout if `throwOnTimeoutError` is
	 * `true` (the default) — in that case the transaction's actual outcome is unknown, not
	 * necessarily failed.
	 */
	async confirmTransactionPolling(
		signature: TransactionSignature,
		commitment: Commitment = 'finalized'
	): Promise<RpcResponseAndContext<SignatureResult> | undefined> {
		let totalTime = 0;
		let backoffTime = 400; // approx block time
		const start = Date.now();

		while (totalTime < this.timeout) {
			await new Promise((resolve) => setTimeout(resolve, backoffTime));

			const rpcResponse = await this.connection.getSignatureStatuses([
				signature,
			]);

			const signatureResult = rpcResponse && rpcResponse.value?.[0];

			// a stronger status satisfies a weaker commitment (processed < confirmed < finalized),
			// e.g. a tx already finalized must not keep a 'confirmed' wait polling until timeout
			const statusRank: Record<string, number> = {
				processed: 0,
				confirmed: 1,
				finalized: 2,
			};
			if (
				rpcResponse &&
				signatureResult &&
				signatureResult.confirmationStatus &&
				statusRank[signatureResult.confirmationStatus] >=
					(statusRank[commitment] ?? 2)
			) {
				return {
					context: rpcResponse.context,
					value: { err: signatureResult.err },
				};
			}

			totalTime += backoffTime;
			backoffTime = Math.min(backoffTime * 2, 5000);
		}

		// Transaction not confirmed within 30 seconds
		this.timeoutCount += 1;
		const duration = (Date.now() - start) / 1000;
		if (this.throwOnTimeoutError) {
			throw new TxSendError(
				`Transaction was not confirmed in ${duration.toFixed(
					2
				)} seconds. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
				NOT_CONFIRMED_ERROR_CODE
			);
		}
	}

	/**
	 * Confirms a transaction using whichever strategy `this.confirmationStrategy` selects:
	 * `WebSocket`/`Combo` route to `confirmTransactionWebSocket`, `Polling` to `confirmTransactionPolling`.
	 * @param signature - Base58-encoded transaction signature to confirm.
	 * @param commitment - Commitment level to wait for.
	 * @returns The confirmation result, or `undefined` on timeout if `throwOnTimeoutError` is `false`.
	 * @throws TxSendError on timeout if `throwOnTimeoutError` is `true` (see `confirmTransactionWebSocket`/`confirmTransactionPolling`).
	 */
	async confirmTransaction(
		signature: TransactionSignature,
		commitment?: Commitment
	): Promise<RpcResponseAndContext<SignatureResult> | undefined> {
		if (
			this.confirmationStrategy === ConfirmationStrategy.WebSocket ||
			this.confirmationStrategy === ConfirmationStrategy.Combo
		) {
			return await this.confirmTransactionWebSocket(signature, commitment);
		} else if (this.confirmationStrategy === ConfirmationStrategy.Polling) {
			return await this.confirmTransactionPolling(signature, commitment);
		}
	}

	/** Current time in milliseconds since epoch (thin wrapper over `Date.now()`, overridable in tests). */
	getTimestamp(): number {
		return new Date().getTime();
	}

	/**
	 * Races an array of promises against a timeout, resolving to `null` (rather than rejecting) if
	 * none settle in time. Unlike `../util/promiseTimeout`, this accepts multiple promises (used to
	 * race confirmation across `connection` plus every `additionalConnections` entry).
	 * @param promises - Promises to race.
	 * @param timeoutMs - Timeout in milliseconds.
	 * @returns The first promise's resolved value, or `null` if none settled before `timeoutMs`.
	 */
	promiseTimeout<T>(
		promises: Promise<T>[],
		timeoutMs: number
	): Promise<T | null> {
		let timeoutId: ReturnType<typeof setTimeout>;
		const timeoutPromise: Promise<null> = new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve(null), timeoutMs);
		});

		return Promise.race([...promises, timeoutPromise]).then(
			(result: T | null) => {
				clearTimeout(timeoutId);
				return result;
			}
		);
	}

	/**
	 * Best-effort broadcasts a raw transaction to every `additionalConnections` entry and invokes
	 * `additionalTxSenderCallbacks` with its base58 encoding. Failures are logged, not thrown or
	 * awaited by the caller — this never affects whether the primary send/confirm succeeds.
	 * @param rawTx - Serialized, signed transaction bytes.
	 * @param opts - Options passed through to each connection's `sendRawTransaction`.
	 */
	sendToAdditionalConnections(
		rawTx: Buffer | Uint8Array,
		opts: ConfirmOptions
	): void {
		this.additionalConnections.map((connection) => {
			connection.sendRawTransaction(rawTx, opts).catch((e) => {
				console.error(
					// @ts-ignore
					`error sending tx to additional connection ${connection._rpcEndpoint}`
				);
				console.error(e);
			});
		});
		this.additionalTxSenderCallbacks?.map((callback) => {
			callback(bs58.encode(rawTx));
		});
	}

	/**
	 * Adds an extra RPC connection to broadcast future transactions to, unless a connection with
	 * the same RPC endpoint is already registered.
	 * @param newConnection - Connection to add to `additionalConnections`.
	 */
	public addAdditionalConnection(newConnection: Connection): void {
		const alreadyUsingConnection =
			this.additionalConnections.filter((connection) => {
				// @ts-ignore
				return connection._rpcEndpoint === newConnection.rpcEndpoint;
			}).length > 0;

		if (!alreadyUsingConnection) {
			this.additionalConnections.push(newConnection);
		}
	}

	/** @returns The number of confirmation attempts that have timed out so far. */
	public getTimeoutCount(): number {
		return this.timeoutCount;
	}

	/**
	 * Inspects a confirmed signature's result and, if it recorded an on-chain error, resolves the
	 * detailed program error via `throwTransactionError` and throws it. Note this check runs
	 * whenever `result.err` is set, independent of the `throwOnTransactionError` field — callers
	 * that want to suppress transaction-error throwing should avoid calling this method rather
	 * than rely on that flag here.
	 * @param txSig - Transaction signature to look up the detailed error for.
	 * @param result - The `SignatureResult` returned by confirmation.
	 * @throws Error the resolved on-chain program error, if `result.err` is set.
	 */
	public async checkConfirmationResultForError(
		txSig: string,
		result: SignatureResult
	): Promise<void> {
		if (result?.err) {
			await throwTransactionError(
				txSig,
				this.connection,
				this.opts?.commitment
			);
		}

		return;
	}

	/**
	 * Computes the fraction of recently sent transactions (within `lookbackWindowMinutes`) that
	 * landed, from `txSigCache`'s current entries. Returns the last computed `txLandRate` (default
	 * 0) if `trackTxLandRate` is disabled or the cache is empty, rather than recomputing.
	 * @returns The land rate as a fraction between 0 and 1.
	 */
	public getTxLandRate(): number {
		if (!this.trackTxLandRate || !this.txSigCache) {
			return this.txLandRate;
		}
		const keys = this.txSigCache.keys();
		const denominator = keys.length;
		if (denominator === 0) {
			return this.txLandRate;
		}
		let numerator = 0;
		for (const key of keys) {
			const value = this.txSigCache.get(key);
			if (value) {
				numerator += 1;
			}
		}
		this.txLandRate = numerator / denominator;
		return this.txLandRate;
	}

	/**
	 * Default `landRateToFeeFunc`: returns `1` (no boost) if the land rate is already at/above
	 * `BASELINE_TX_LAND_RATE` (0.9) or fewer than 3 samples have been recorded yet (too little data
	 * to react); otherwise returns a multiplier that grows logarithmically as the land rate falls
	 * further below baseline, capped at `10`.
	 * @param txLandRate - Recent land rate, 0-1 (see `getTxLandRate`).
	 * @returns A priority-fee multiplier between 1 and 10.
	 */
	private defaultLandRateToFeeFunc(txLandRate: number) {
		if (
			txLandRate >= BASELINE_TX_LAND_RATE ||
			(this.txSigCache?.keys().length ?? 0) < 3
		) {
			return 1;
		}
		const multiplier =
			10 * Math.log10(1 + (BASELINE_TX_LAND_RATE - txLandRate) * 5);
		return Math.min(multiplier, 10);
	}

	/**
	 * Suggests a multiplier to apply to a base priority fee, based on recent land rate — intended
	 * for callers to scale up their compute-unit price when transactions have been landing poorly.
	 * @returns `1` (no change) if `trackTxLandRate` is disabled; otherwise `landRateToFeeFunc(getTxLandRate())`.
	 */
	public getSuggestedPriorityFeeMultiplier(): number {
		if (!this.trackTxLandRate) {
			return 1;
		}
		return this.landRateToFeeFunc(this.getTxLandRate());
	}
}
