/**
 * Transaction building and sending infrastructure.
 *
 * `txHandler.ts`     — base class for building versioned/legacy transactions with ALT support.
 * `retryTxSender.ts` — retry loop with confirmation polling (default for most clients).
 * `fastSingleTxSender.ts` — fire-and-forget path for latency-sensitive keeper bots.
 * `priorityFeeCalculator.ts` — computes dynamic priority fees from recent fee estimates.
 * `txParamProcessor.ts` — resolves CU limits and priority fees before send.
 *
 * Transaction sender is injected via VelocityClientConfig; swap implementations to tune
 * confirmation strategy without changing instruction-building code.
 */
import {
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
	Commitment,
	ComputeBudgetProgram,
	ConfirmOptions,
	Connection,
	Message,
	MessageV0,
	Signer,
	SimulatedTransactionResponse,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
	TransactionVersion,
	VersionedTransaction,
} from '@solana/web3.js';
import { TransactionParamProcessor } from './txParamProcessor';
import bs58 from 'bs58';
import {
	BaseTxParams,
	VelocityClientMetricsEvents,
	IWallet,
	MappedRecord,
	SignedTxData,
	TxParams,
} from '../types';
import { containsComputeUnitIxs } from '../util/computeUnits';
import { CachedBlockhashFetcher } from './blockhashFetcher/cachedBlockhashFetcher';
import { BaseBlockhashFetcher } from './blockhashFetcher/baseBlockhashFetcher';
import { BlockhashFetcher } from './blockhashFetcher/types';
import {
	getSizeOfTransaction,
	isVersionedTransaction,
	MAX_TX_BYTE_SIZE,
} from './utils';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

/**
 * Explanation for SIGNATURE_BLOCK_AND_EXPIRY:
 *
 * When the whileValidTxSender waits for confirmation of a given transaction, it needs the last available blockheight and blockhash used in the signature to do so. For pre-signed transactions, these values aren't attached to the transaction object by default. For a "scrappy" workaround which doesn't break backwards compatibility, the SIGNATURE_BLOCK_AND_EXPIRY property is simply attached to the transaction objects as they are created or signed in this handler despite a mismatch in the typescript types. If the values are attached to the transaction when they reach the whileValidTxSender, it can opt-in to use these values.
 */

const DEV_TRY_FORCE_TX_TIMEOUTS =
	process.env.DEV_TRY_FORCE_TX_TIMEOUTS === 'true' || false;

export const COMPUTE_UNITS_DEFAULT = 200_000;

const BLOCKHASH_FETCH_RETRY_COUNT = 3;
const BLOCKHASH_FETCH_RETRY_SLEEP = 200;
const RECENT_BLOCKHASH_STALE_TIME_MS = 2_000; // Reuse blockhashes within this timeframe during bursts of tx contruction

/** Inputs to `TxHandler.buildTransaction`/`buildBulkTransactions` describing what to build and how. */
export type TxBuildingProps = {
	instructions: TransactionInstruction | TransactionInstruction[];
	/** `'legacy'` for a legacy `Transaction`, or `0` for a v0 `VersionedTransaction`. */
	txVersion: TransactionVersion;
	connection: Connection;
	/** Commitment used when building/signing multiple legacy transactions via `getPreparedAndSignedLegacyTransactionMap`. */
	preFlightCommitment?: Commitment;
	/** Supplies the market address lookup tables to merge with `lookupTables` for a v0 transaction. */
	fetchAllMarketLookupTableAccounts: () => Promise<AddressLookupTableAccount[]>;
	/** Extra address lookup tables to compile the message against, in addition to the market ones from `fetchAllMarketLookupTableAccounts`. */
	lookupTables?: AddressLookupTableAccount[];
	/** If `true`, return a `VersionedTransaction` even when `txVersion === 'legacy'` (wraps the legacy message in a versioned envelope). */
	forceVersionedTransaction?: boolean;
	/** Compute-unit limit/price and simulation-based sizing options for this transaction. */
	txParams?: TxParams;
	/** Blockhash to use; if omitted, one is resolved via `TxHandler`'s `BlockhashFetcher`. */
	recentBlockhash?: BlockhashWithExpiryBlockHeight;
	wallet?: IWallet;
	optionalIxs?: TransactionInstruction[]; // additional instructions to add to the front of ixs if there's enough room, such as oracle cranks
	simulatedTx?: SimulatedTransactionResponse; // we could have pre-simulated the tx and we can use this later to get compute units
};

/** Configuration for `TxHandler`'s blockhash-fetching strategy. */
export type TxHandlerConfig = {
	/** If `true`, use a `CachedBlockhashFetcher` (reduces RPC calls during bursts of tx construction); otherwise fetch fresh every time via `BaseBlockhashFetcher`. */
	blockhashCachingEnabled?: boolean;
	/** Tuning for `CachedBlockhashFetcher` when `blockhashCachingEnabled` is `true`; each field defaults if omitted (see `BLOCKHASH_FETCH_RETRY_COUNT`/`BLOCKHASH_FETCH_RETRY_SLEEP`/`RECENT_BLOCKHASH_STALE_TIME_MS`). */
	blockhashCachingConfig?: {
		retryCount?: number;
		retrySleepTimeMs?: number;
		staleCacheTimeMs?: number;
	};
};

/**
 * This class is responsible for creating and signing transactions.
 *
 * Owns blockhash resolution (via a `BlockhashFetcher`, optionally caching), compute-budget
 * instruction injection, address-lookup-table compilation, and wallet signing for both legacy and
 * v0 transactions, single or batched. `TxSender` implementations delegate to a `TxHandler`
 * instance for all of this rather than duplicating it.
 */
export class TxHandler {
	private blockHashToLastValidBlockHeightLookup: Record<string, number> = {};
	private returnBlockHeightsWithSignedTxCallbackData = false;

	private connection: Connection;
	private wallet: IWallet;
	private confirmationOptions: ConfirmOptions;

	private preSignedCb?: () => void;
	private onSignedCb?: (
		txSigs: VelocityClientMetricsEvents['txSigned']
	) => void;

	private blockhashCommitment: Commitment =
		DEFAULT_CONFIRMATION_OPTS.commitment ?? 'confirmed';
	private blockHashFetcher: BlockhashFetcher;

	/**
	 * @param props.connection - RPC connection used for blockhash fetches and (indirectly) sends.
	 * @param props.wallet - Default wallet used to sign transactions when a call doesn't pass its own.
	 * @param props.confirmationOptions - Default confirm options; `preflightCommitment` (falling
	 * back to `connection.commitment`, then `'confirmed'`) sets the commitment used for blockhash fetches.
	 * @param props.opts.returnBlockHeightsWithSignedTxCallbackData - If `true`, `onSignedCb` receives each signed tx's `lastValidBlockHeight` alongside its signature/blockhash.
	 * @param props.opts.onSignedCb - Callback invoked with signed-transaction metadata whenever this handler signs one or more transactions.
	 * @param props.opts.preSignedCb - Callback invoked immediately before wallet signing occurs.
	 * @param props.config - Blockhash-fetching strategy/tuning; see `TxHandlerConfig`.
	 */
	constructor(props: {
		connection: Connection;
		wallet: IWallet;
		confirmationOptions: ConfirmOptions;
		opts?: {
			returnBlockHeightsWithSignedTxCallbackData?: boolean;
			onSignedCb?: (txSigs: VelocityClientMetricsEvents['txSigned']) => void;
			preSignedCb?: () => void;
		};
		config?: TxHandlerConfig;
	}) {
		this.connection = props.connection;
		this.wallet = props.wallet;
		this.confirmationOptions = props.confirmationOptions;
		this.blockhashCommitment =
			props.confirmationOptions?.preflightCommitment ??
			props?.connection?.commitment ??
			this.blockhashCommitment ??
			'confirmed';

		this.blockHashFetcher = props?.config?.blockhashCachingEnabled
			? new CachedBlockhashFetcher(
					this.connection,
					this.blockhashCommitment,
					props?.config?.blockhashCachingConfig?.retryCount ??
						BLOCKHASH_FETCH_RETRY_COUNT,
					props?.config?.blockhashCachingConfig?.retrySleepTimeMs ??
						BLOCKHASH_FETCH_RETRY_SLEEP,
					props?.config?.blockhashCachingConfig?.staleCacheTimeMs ??
						RECENT_BLOCKHASH_STALE_TIME_MS
			  )
			: new BaseBlockhashFetcher(this.connection, this.blockhashCommitment);

		// #Optionals
		this.returnBlockHeightsWithSignedTxCallbackData =
			props.opts?.returnBlockHeightsWithSignedTxCallbackData ?? false;
		this.onSignedCb = props.opts?.onSignedCb;
		this.preSignedCb = props.opts?.preSignedCb;
	}

	/** @returns The wallet this handler currently uses to sign transactions when a call doesn't pass its own. */
	public getWallet() {
		return this.wallet;
	}

	private addHashAndExpiryToLookup(
		hashAndExpiry: BlockhashWithExpiryBlockHeight
	) {
		if (!this.returnBlockHeightsWithSignedTxCallbackData) return;

		this.blockHashToLastValidBlockHeightLookup[hashAndExpiry.blockhash] =
			hashAndExpiry.lastValidBlockHeight;
	}

	private getProps = (wallet?: IWallet, confirmationOpts?: ConfirmOptions) =>
		[wallet ?? this.wallet, confirmationOpts ?? this.confirmationOptions] as [
			IWallet,
			ConfirmOptions,
		];

	/**
	 * Swaps the default wallet used for subsequent signing calls that don't pass their own.
	 * @param wallet - New default wallet.
	 */
	public updateWallet(wallet: IWallet) {
		this.wallet = wallet;
	}

	/**
	 * Created this to prevent non-finalized blockhashes being used when building transactions. We want to always use finalized because otherwise it's easy to get the BlockHashNotFound error (RPC uses finalized to validate a transaction). Using an older blockhash when building transactions should never really be a problem right now.
	 *
	 * https://www.helius.dev/blog/how-to-deal-with-blockhash-errors-on-solana#why-do-blockhash-errors-occur
	 *
	 * @returns The latest blockhash (via this handler's configured `BlockhashFetcher`) at the
	 * commitment level resolved in the constructor, or `undefined` if unavailable.
	 */
	public async getLatestBlockhashForTransaction() {
		return this.blockHashFetcher.getLatestBlockhash();
	}

	/**
	 * Resolves a usable recent blockhash, preferring a caller-provided one and
	 * otherwise fetching the latest. Throws if no blockhash can be obtained,
	 * since a transaction cannot be built or signed without one.
	 */
	private async resolveRecentBlockhash(
		recentBlockhash?: BlockhashWithExpiryBlockHeight
	): Promise<BlockhashWithExpiryBlockHeight> {
		const resolved =
			recentBlockhash ?? (await this.getLatestBlockhashForTransaction());
		if (!resolved) {
			throw new Error('TxHandler: failed to fetch a recent blockhash');
		}
		return resolved;
	}

	/**
	 * Applies recent blockhash and signs a given transaction. Attaches an internal
	 * `SIGNATURE_BLOCK_AND_EXPIRY` property (undocumented in the `Transaction` type, but read by
	 * `WhileValidTxSender`) recording the blockhash/expiry used, so confirmation logic can know
	 * when the transaction's blockhash has expired even for pre-built transactions.
	 * @param tx - Transaction to prepare; mutated in place (feePayer, recentBlockhash, signature).
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param wallet - Wallet to sign with; defaults to this handler's configured wallet.
	 * @param confirmationOpts - Unused directly here (present for interface symmetry with other overloads).
	 * @param preSigned - If `true`, return `tx` unchanged without touching blockhash/feePayer/signatures.
	 * @param recentBlockhash - Blockhash to use; if omitted, resolved via `getLatestBlockhashForTransaction`.
	 * @returns The prepared (and signed, unless `preSigned`) transaction.
	 * @throws Error if no blockhash could be resolved.
	 */
	public async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		wallet?: IWallet,
		confirmationOpts?: ConfirmOptions,
		preSigned?: boolean,
		recentBlockhash?: BlockhashWithExpiryBlockHeight
	): Promise<Transaction> {
		if (preSigned) {
			return tx;
		}

		[wallet, confirmationOpts] = this.getProps(wallet, confirmationOpts);

		tx.feePayer = wallet.publicKey;
		const resolvedBlockhash = await this.resolveRecentBlockhash(
			recentBlockhash
		);
		tx.recentBlockhash = resolvedBlockhash.blockhash;

		this.addHashAndExpiryToLookup(resolvedBlockhash);

		const signedTx = await this.signTx(tx, additionalSigners);

		// @ts-ignore
		signedTx.SIGNATURE_BLOCK_AND_EXPIRY = resolvedBlockhash;

		return signedTx;
	}

	private isVersionedTransaction(
		tx: Transaction | VersionedTransaction
	): boolean {
		return isVersionedTransaction(tx);
	}

	private isLegacyTransaction(tx: Transaction | VersionedTransaction) {
		return !this.isVersionedTransaction(tx);
	}

	private getTxSigFromSignedTx(signedTx: Transaction | VersionedTransaction) {
		if (this.isVersionedTransaction(signedTx)) {
			return bs58.encode(
				Buffer.from((signedTx as VersionedTransaction).signatures[0])
			) as string;
		} else {
			const signature = (signedTx as Transaction).signature;
			if (!signature) {
				throw new Error(
					'TxHandler: cannot derive txSig from an unsigned legacy transaction'
				);
			}
			return bs58.encode(Buffer.from(signature)) as string;
		}
	}

	private getBlockhashFromSignedTx(
		signedTx: Transaction | VersionedTransaction
	): string {
		const blockHash = this.isVersionedTransaction(signedTx)
			? (signedTx as VersionedTransaction).message.recentBlockhash
			: (signedTx as Transaction).recentBlockhash;

		if (!blockHash) {
			throw new Error(
				'TxHandler: signed transaction is missing a recentBlockhash'
			);
		}

		return blockHash;
	}

	private async signTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		wallet?: IWallet
	): Promise<Transaction> {
		[wallet] = this.getProps(wallet);

		additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});

		this.preSignedCb?.();

		const signedTx = await wallet.signTransaction(tx);

		// Turn txSig Buffer into base58 string
		const txSig = this.getTxSigFromSignedTx(signedTx);

		this.handleSignedTxData([
			{
				txSig,
				signedTx,
				blockHash: this.getBlockhashFromSignedTx(signedTx),
			},
		]);

		return signedTx;
	}

	/**
	 * Signs a `VersionedTransaction`, optionally overwriting its blockhash first.
	 * @param tx - Transaction to sign; mutated in place.
	 * @param additionalSigners - Extra signers to co-sign alongside the wallet.
	 * @param recentBlockhash - If provided, overwrites `tx.message.recentBlockhash` before signing
	 * (and records it for `SIGNATURE_BLOCK_AND_EXPIRY` tracking); if omitted, the transaction's
	 * existing blockhash is used as-is.
	 * @param wallet - Wallet to sign with; defaults to this handler's configured wallet.
	 * @returns The signed transaction.
	 */
	public async signVersionedTx(
		tx: VersionedTransaction,
		additionalSigners: Array<Signer>,
		recentBlockhash?: BlockhashWithExpiryBlockHeight,
		wallet?: IWallet
	): Promise<VersionedTransaction> {
		[wallet] = this.getProps(wallet);

		if (recentBlockhash) {
			tx.message.recentBlockhash = recentBlockhash.blockhash;

			this.addHashAndExpiryToLookup(recentBlockhash);

			// @ts-ignore
			tx.SIGNATURE_BLOCK_AND_EXPIRY = recentBlockhash;
		}

		additionalSigners
			?.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.sign([kp]);
			});

		this.preSignedCb?.();

		//@ts-ignore
		const signedTx = (await wallet.signTransaction(tx)) as VersionedTransaction;

		// Turn txSig Buffer into base58 string
		const txSig = this.getTxSigFromSignedTx(signedTx);

		this.handleSignedTxData([
			{
				txSig,
				signedTx,
				blockHash: this.getBlockhashFromSignedTx(signedTx),
			},
		]);

		return signedTx;
	}

	private handleSignedTxData(
		txData: Omit<SignedTxData, 'lastValidBlockHeight'>[]
	): SignedTxData[] {
		if (!this.returnBlockHeightsWithSignedTxCallbackData) {
			if (this.onSignedCb) {
				this.onSignedCb(txData);
			}

			return [];
		}

		const signedTxData = txData.map((tx) => {
			const lastValidBlockHeight =
				this.blockHashToLastValidBlockHeightLookup[tx.blockHash];

			return {
				...tx,
				lastValidBlockHeight,
			};
		});

		if (this.onSignedCb) {
			this.onSignedCb(signedTxData);
		}

		return signedTxData;
	}

	/**
	 * Gets transaction params with extra processing applied, like using the simulated compute units or using a dynamically calculated compute unit price.
	 * @param txBuildingProps
	 * @returns
	 */
	private async getProcessedTransactionParams(
		txBuildingProps: TxBuildingProps
	): Promise<BaseTxParams> {
		const baseTxParams: BaseTxParams = {
			computeUnits: txBuildingProps?.txParams?.computeUnits,
			computeUnitsPrice: txBuildingProps?.txParams?.computeUnitsPrice,
		};

		const processedTxParams = await TransactionParamProcessor.process({
			baseTxParams,
			txBuilder: (updatedTxParams) =>
				this.buildTransaction({
					...txBuildingProps,
					txParams: updatedTxParams.txParams ?? baseTxParams,
					forceVersionedTransaction: true,
				}) as Promise<VersionedTransaction>,
			processConfig: {
				useSimulatedComputeUnits:
					txBuildingProps.txParams?.useSimulatedComputeUnits,
				computeUnitsBufferMultiplier:
					txBuildingProps.txParams?.computeUnitsBufferMultiplier,
				useSimulatedComputeUnitsForCUPriceCalculation:
					txBuildingProps.txParams
						?.useSimulatedComputeUnitsForCUPriceCalculation,
				getCUPriceFromComputeUnits:
					txBuildingProps.txParams?.getCUPriceFromComputeUnits,
			},
			processParams: {
				connection: this.connection,
				simulatedTx: txBuildingProps.simulatedTx,
			},
		});

		return processedTxParams;
	}

	private _generateVersionedTransaction(
		recentBlockhash: BlockhashWithExpiryBlockHeight,
		message: Message | MessageV0
	) {
		this.addHashAndExpiryToLookup(recentBlockhash);

		return new VersionedTransaction(message);
	}

	/**
	 * Builds an unsigned `VersionedTransaction` that wraps a *legacy* compiled message (no address
	 * lookup tables) — used when `forceVersionedTransaction` is requested for a `'legacy'`
	 * `txVersion`.
	 * @param recentBlockhash - Blockhash to build the message with.
	 * @param ixs - Instructions to include, in order.
	 * @param wallet - Wallet whose pubkey becomes the fee payer; defaults to this handler's configured wallet.
	 * @returns The unsigned `VersionedTransaction`.
	 */
	public generateLegacyVersionedTransaction(
		recentBlockhash: BlockhashWithExpiryBlockHeight,
		ixs: TransactionInstruction[],
		wallet?: IWallet
	) {
		[wallet] = this.getProps(wallet);

		const message = new TransactionMessage({
			payerKey: wallet.publicKey,
			recentBlockhash: recentBlockhash.blockhash,
			instructions: ixs,
		}).compileToLegacyMessage();

		const tx = this._generateVersionedTransaction(recentBlockhash, message);

		// @ts-ignore
		tx.SIGNATURE_BLOCK_AND_EXPIRY = recentBlockhash;

		return tx;
	}

	/**
	 * Builds an unsigned v0 `VersionedTransaction`, compiling its message against the given
	 * address lookup tables.
	 * @param recentBlockhash - Blockhash to build the message with.
	 * @param ixs - Instructions to include, in order.
	 * @param lookupTableAccounts - Address lookup tables to compile the message against.
	 * @param wallet - Wallet whose pubkey becomes the fee payer; defaults to this handler's configured wallet.
	 * @returns The unsigned `VersionedTransaction`.
	 */
	public generateVersionedTransaction(
		recentBlockhash: BlockhashWithExpiryBlockHeight,
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		wallet?: IWallet
	) {
		[wallet] = this.getProps(wallet);

		const message = new TransactionMessage({
			payerKey: wallet.publicKey,
			recentBlockhash: recentBlockhash.blockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		const tx = this._generateVersionedTransaction(recentBlockhash, message);

		// @ts-ignore
		tx.SIGNATURE_BLOCK_AND_EXPIRY = recentBlockhash;

		return tx;
	}

	/**
	 * Builds an unsigned legacy `Transaction` from raw instructions. Unlike the other `generate*`
	 * methods, this does not set a fee payer.
	 * @param ixs - Instructions to include, in order.
	 * @param recentBlockhash - If provided, sets `tx.recentBlockhash`; otherwise left unset.
	 * @returns The unsigned `Transaction`.
	 */
	public generateLegacyTransaction(
		ixs: TransactionInstruction[],
		recentBlockhash?: BlockhashWithExpiryBlockHeight
	) {
		const tx = new Transaction().add(...ixs);
		if (recentBlockhash) {
			tx.recentBlockhash = recentBlockhash.blockhash;
		}
		return tx;
	}

	/**
	 * Accepts multiple instructions and builds a transaction for each. Prevents needing to spam RPC with requests for the same blockhash.
	 * @param props - Shared `TxBuildingProps` (minus `instructions`) plus one instruction/array
	 * per output transaction; a falsy entry in `props.instructions` yields `undefined` at that
	 * position rather than being built.
	 * @returns One built transaction (or `undefined`) per entry in `props.instructions`, in the same order.
	 */
	public async buildBulkTransactions(
		props: Omit<TxBuildingProps, 'instructions'> & {
			instructions: (TransactionInstruction | TransactionInstruction[])[];
		}
	) {
		const recentBlockhash = await this.resolveRecentBlockhash(
			props?.recentBlockhash
		);

		return await Promise.all(
			props.instructions.map((ix) => {
				if (!ix) return undefined;
				return this.buildTransaction({
					...props,
					instructions: ix,
					recentBlockhash,
				});
			})
		);
	}

	/**
	 * Builds a full transaction from raw instructions: merges caller-supplied `lookupTables` with
	 * the market lookup tables from `fetchAllMarketLookupTableAccounts`, optionally appends as many
	 * `optionalIxs` (e.g. oracle cranks) as fit under `MAX_TX_BYTE_SIZE` (dropped one-by-one and
	 * re-simulated if the batch fails simulation), resolves compute-unit limit/price (via
	 * simulation if `txParams.useSimulatedComputeUnits`), and prepends the resulting
	 * `ComputeBudgetProgram` instructions unless the caller's instructions already include them.
	 * @param props - See `TxBuildingProps`. `props.forceVersionedTransaction` returns a
	 * `VersionedTransaction` instance even if `props.txVersion` is `'legacy'`.
	 * @returns The built transaction — a `Transaction` for `txVersion === 'legacy'` unless
	 * `forceVersionedTransaction` is set, otherwise a `VersionedTransaction`. Not yet signed.
	 */
	public async buildTransaction(
		props: TxBuildingProps
	): Promise<Transaction | VersionedTransaction> {
		const {
			txVersion,
			txParams,
			connection: _connection,
			preFlightCommitment: _preFlightCommitment,
			fetchAllMarketLookupTableAccounts,
			forceVersionedTransaction,
			instructions,
		} = props;

		let { lookupTables } = props;

		const marketLookupTables = await fetchAllMarketLookupTableAccounts();

		// Combine and filter out any null/undefined lookup tables
		const combinedLookupTables = lookupTables
			? [...lookupTables, ...marketLookupTables]
			: marketLookupTables;
		lookupTables = combinedLookupTables.filter(
			(table): table is AddressLookupTableAccount =>
				table !== null && table !== undefined
		);

		// # Collect and process Tx Params
		let baseTxParams: BaseTxParams = {
			computeUnits: txParams?.computeUnits,
			computeUnitsPrice: txParams?.computeUnitsPrice,
		};

		const instructionsArray = Array.isArray(instructions)
			? instructions
			: [instructions];

		let instructionsToUse: TransactionInstruction[];
		let simulatedTx: SimulatedTransactionResponse | undefined;
		// add optional ixs if there's room and it doesn't fail simulation (usually oracle cranks)
		if (props.optionalIxs && txVersion === 0) {
			[instructionsToUse, simulatedTx] =
				await this.simulateAndCalculateInstructions(
					{
						...props,
						instructions: instructionsArray,
						txVersion,
						lookupTables,
					},
					props.optionalIxs,
					txVersion === 0,
					lookupTables
				);
		} else {
			instructionsToUse = instructionsArray;
		}

		if (txParams?.useSimulatedComputeUnits) {
			const processedTxParams = await this.getProcessedTransactionParams({
				...props,
				instructions: instructionsToUse,
				simulatedTx: simulatedTx,
			});

			baseTxParams = {
				...baseTxParams,
				...processedTxParams,
			};
		}

		const { hasSetComputeUnitLimitIx, hasSetComputeUnitPriceIx } =
			containsComputeUnitIxs(instructionsToUse);

		// # Create Tx Instructions
		const allIx = [];
		const computeUnits = baseTxParams?.computeUnits;
		if (
			computeUnits !== undefined &&
			computeUnits > 0 &&
			!hasSetComputeUnitLimitIx
		) {
			allIx.push(
				ComputeBudgetProgram.setComputeUnitLimit({
					units: computeUnits,
				})
			);
		}

		const computeUnitsPrice = baseTxParams?.computeUnitsPrice;

		if (DEV_TRY_FORCE_TX_TIMEOUTS) {
			allIx.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: 0,
				})
			);
		} else if (
			computeUnitsPrice !== undefined &&
			computeUnitsPrice > 0 &&
			!hasSetComputeUnitPriceIx
		) {
			allIx.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: computeUnitsPrice,
				})
			);
		}

		allIx.push(...instructionsToUse);

		const recentBlockhash = await this.resolveRecentBlockhash(
			props?.recentBlockhash
		);

		// # Create and return Transaction
		if (txVersion === 'legacy') {
			if (forceVersionedTransaction) {
				return this.generateLegacyVersionedTransaction(recentBlockhash, allIx);
			} else {
				return this.generateLegacyTransaction(allIx, recentBlockhash);
			}
		} else {
			return this.generateVersionedTransaction(
				recentBlockhash,
				allIx,
				lookupTables
			);
		}
	}

	/**
	 * Wraps a single instruction in a legacy `Transaction`, prepending compute-budget instructions
	 * as needed. Does not set a blockhash or fee payer.
	 * @param instruction - Instruction to wrap.
	 * @param computeUnits - Compute unit limit; defaults to 600,000. A `setComputeUnitLimit`
	 * instruction is added unless this value equals `COMPUTE_UNITS_DEFAULT` (200,000) exactly —
	 * note the 600,000 default therefore *does* add one.
	 * @param computeUnitsPrice - Compute unit price in micro-lamports; defaults to 0, in which case
	 * no `setComputeUnitPrice` instruction is added.
	 * @returns The unsigned `Transaction`.
	 */
	public wrapInTx(
		instruction: TransactionInstruction,
		computeUnits = 600_000,
		computeUnitsPrice = 0
	): Transaction {
		const tx = new Transaction();
		if (computeUnits != COMPUTE_UNITS_DEFAULT) {
			tx.add(
				ComputeBudgetProgram.setComputeUnitLimit({
					units: computeUnits,
				})
			);
		}

		if (DEV_TRY_FORCE_TX_TIMEOUTS) {
			tx.add(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: 0,
				})
			);
		} else if (computeUnitsPrice != 0) {
			tx.add(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: computeUnitsPrice,
				})
			);
		}

		return tx.add(instruction);
	}

	/**
	 * Get a map of signed and prepared transactions from an array of legacy transactions
	 * @param txsMap - Map of key to legacy `Transaction` (or `undefined`, passed through unset); each is mutated with blockhash/feePayer before signing.
	 * @param wallet - Wallet to sign with; defaults to this handler's configured wallet.
	 * @param commitment - Unused directly here (accepted for interface symmetry with `TxSender.send`-style callers).
	 * @param recentBlockhash - Blockhash to apply to every transaction in `txsMap`; if omitted, resolved via `getLatestBlockhashForTransaction`.
	 * @returns `{ signedTxMap, signedTxData }` — see `getSignedTransactionMap`.
	 * @throws Error if no blockhash could be resolved.
	 */
	public async getPreparedAndSignedLegacyTransactionMap<
		T extends Record<string, Transaction | undefined>,
	>(
		txsMap: T,
		wallet?: IWallet,
		commitment?: Commitment,
		recentBlockhash?: BlockhashWithExpiryBlockHeight
	) {
		const resolvedBlockhash = await this.resolveRecentBlockhash(
			recentBlockhash
		);

		this.addHashAndExpiryToLookup(resolvedBlockhash);

		for (const tx of Object.values(txsMap)) {
			if (!tx) continue;
			tx.recentBlockhash = resolvedBlockhash.blockhash;
			tx.feePayer = wallet?.publicKey ?? this.wallet?.publicKey;

			// @ts-ignore
			tx.SIGNATURE_BLOCK_AND_EXPIRY = resolvedBlockhash;
		}

		return this.getSignedTransactionMap(txsMap, wallet);
	}

	/**
	 * Get a map of signed transactions from an array of transactions to sign. Signs all non-`undefined`
	 * entries in a single `wallet.signAllTransactions` batch (one wallet approval for the whole map,
	 * where the wallet supports it) rather than one signature request per transaction.
	 * @param txsToSignMap - Map of key to `Transaction`/`VersionedTransaction` (or `undefined`,
	 * passed through as `undefined` in the result rather than being signed).
	 * @param wallet - Wallet to sign with; defaults to this handler's configured wallet.
	 * @returns `signedTxMap` — same keys as the input, with each defined entry replaced by its
	 * signed transaction; and `signedTxData` — the per-transaction signature/blockhash metadata
	 * (with `lastValidBlockHeight` if this handler was configured with
	 * `returnBlockHeightsWithSignedTxCallbackData`), also passed to `onSignedCb` if configured.
	 */
	public async getSignedTransactionMap<
		T extends Record<string, Transaction | VersionedTransaction | undefined>,
	>(
		txsToSignMap: T,
		wallet?: IWallet
	): Promise<{
		signedTxMap: T;
		signedTxData: SignedTxData[];
	}> {
		[wallet] = this.getProps(wallet);

		const txsToSignEntries = Object.entries(txsToSignMap);

		// Create a map of the same keys as the input map, but with the values set to undefined. We'll populate the filtered (non-undefined) values with signed transactions.
		const signedTxMap = txsToSignEntries.reduce(
			(acc, [key]) => {
				acc[key] = undefined;
				return acc;
			},
			{} as Record<string, Transaction | VersionedTransaction | undefined>
		) as T;

		const filteredTxEntries = txsToSignEntries.filter(
			(entry): entry is [string, Transaction | VersionedTransaction] =>
				!!entry[1]
		);

		// Extra handling for legacy transactions
		for (const [_key, tx] of filteredTxEntries) {
			if (this.isLegacyTransaction(tx)) {
				(tx as Transaction).feePayer = wallet.publicKey;
			}
		}

		this.preSignedCb?.();

		const signedFilteredTxs = await wallet.signAllTransactions(
			filteredTxEntries.map(([_, tx]) => tx as Transaction)
		);

		signedFilteredTxs.forEach((signedTx, index) => {
			// @ts-ignore
			signedTx.SIGNATURE_BLOCK_AND_EXPIRY =
				// @ts-ignore
				filteredTxEntries[index][1]?.SIGNATURE_BLOCK_AND_EXPIRY;
		});

		const signedTxData = this.handleSignedTxData(
			signedFilteredTxs.map((signedTx) => {
				return {
					txSig: this.getTxSigFromSignedTx(signedTx),
					signedTx,
					blockHash: this.getBlockhashFromSignedTx(signedTx),
				};
			})
		);

		filteredTxEntries.forEach(([key], index) => {
			const signedTx = signedFilteredTxs[index];
			// @ts-ignore
			signedTxMap[key] = signedTx;
		});

		return { signedTxMap, signedTxData };
	}

	/**
	 * Accepts multiple instructions and builds a transaction for each. Prevents needing to spam RPC with requests for the same blockhash.
	 * @param props - Shared `TxBuildingProps` (minus `instructions`) plus a named map of instruction(s) per output transaction.
	 * @returns A map with the same keys as `props.instructionsMap`, each value the corresponding built transaction.
	 */
	public async buildTransactionsMap<
		T extends Record<string, TransactionInstruction | TransactionInstruction[]>,
	>(
		props: Omit<TxBuildingProps, 'instructions'> & {
			instructionsMap: T;
		}
	): Promise<MappedRecord<T, Transaction | VersionedTransaction>> {
		const builtTxs = await this.buildBulkTransactions({
			...props,
			instructions: Object.values(props.instructionsMap),
		});

		return Object.keys(props.instructionsMap).reduce(
			(acc, key, index) => {
				acc[key] = builtTxs[index];
				return acc;
			},
			{} as Record<string, Transaction | VersionedTransaction | undefined>
		) as MappedRecord<T, Transaction | VersionedTransaction>;
	}

	/**
	 * Builds and signs transactions from a given array of instructions for multiple transactions.
	 * Builds every transaction first (`buildTransactionsMap`), then signs them all in one batch —
	 * via `getPreparedAndSignedLegacyTransactionMap` for `'legacy'` `txVersion`, otherwise
	 * `getSignedTransactionMap`.
	 * @param props - Shared `TxBuildingProps` (minus `instructions`) plus a named map of instruction(s) per output transaction.
	 * @returns `{ signedTxMap, signedTxData }` keyed the same as `props.instructionsMap`; see `getSignedTransactionMap`.
	 */
	public async buildAndSignTransactionMap<
		T extends Record<string, TransactionInstruction | TransactionInstruction[]>,
	>(
		props: Omit<TxBuildingProps, 'instructions'> & {
			instructionsMap: T;
		}
	) {
		const builtTxs = await this.buildTransactionsMap(props);

		const preppedTransactions = await (props.txVersion === 'legacy'
			? this.getPreparedAndSignedLegacyTransactionMap(
					builtTxs as Record<string, Transaction>,
					props.wallet,
					props.preFlightCommitment
			  )
			: this.getSignedTransactionMap(builtTxs, props.wallet));

		return preppedTransactions;
	}

	/**
	 * Greedily includes as many `optionalInstructions` (e.g. oracle-crank instructions) as fit
	 * alongside `txBuildingProps.instructions` under `MAX_TX_BYTE_SIZE`, then simulates the result;
	 * if simulation fails, falls back to simulating with only the base instructions (optional ones
	 * dropped entirely) rather than trying to isolate which optional instruction caused the failure.
	 * @param txBuildingProps - Build props whose `instructions` are the required (non-optional) instructions.
	 * @param optionalInstructions - Extra instructions to include only if they fit; prepended
	 * ahead of the base instructions and trimmed one-by-one from the front if the combined size
	 * exceeds `MAX_TX_BYTE_SIZE`. Defaults to none, in which case this is a no-op passthrough.
	 * @param versionedTransaction - Whether to size the candidate transaction as versioned (v0) or legacy; defaults to `true`.
	 * @param addressLookupTables - Lookup tables credited toward the size calculation; defaults to none.
	 * @returns A tuple of `[instructionsActuallyUsed, simulationResult]` — `instructionsActuallyUsed`
	 * includes the optional instructions only if the combined simulation succeeded; `simulationResult`
	 * is `undefined` only when `optionalInstructions` was empty (no simulation was needed).
	 */
	public async simulateAndCalculateInstructions(
		txBuildingProps: TxBuildingProps,
		optionalInstructions: TransactionInstruction[] = [],
		versionedTransaction = true,
		addressLookupTables: AddressLookupTableAccount[] = []
	): Promise<
		[TransactionInstruction[], SimulatedTransactionResponse | undefined]
	> {
		const baseInstructions = Array.isArray(txBuildingProps.instructions)
			? txBuildingProps.instructions
			: [txBuildingProps.instructions];
		if (optionalInstructions.length === 0) {
			return [baseInstructions, undefined];
		}

		let allInstructions = [...optionalInstructions, ...baseInstructions];

		let txSize = getSizeOfTransaction(
			allInstructions,
			versionedTransaction,
			addressLookupTables
		);

		while (
			txSize > MAX_TX_BYTE_SIZE &&
			allInstructions.length > baseInstructions.length
		) {
			allInstructions = allInstructions.slice(1);
			txSize = getSizeOfTransaction(
				allInstructions,
				versionedTransaction,
				addressLookupTables
			);
		}

		const tx = await this.buildTransaction({
			...txBuildingProps,
			optionalIxs: undefined,
			instructions: allInstructions,
		});

		const simulatedTx = await this.connection.simulateTransaction(
			tx as VersionedTransaction
		);

		if (simulatedTx.value?.err) {
			const tx = await this.buildTransaction({
				...txBuildingProps,
				optionalIxs: undefined,
				instructions: baseInstructions,
			});
			const simulationWithoutOptionalIxs =
				await this.connection.simulateTransaction(tx as VersionedTransaction);
			return [baseInstructions, simulationWithoutOptionalIxs.value];
		}

		return [allInstructions, simulatedTx.value];
	}
}
