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
	DriftClientMetricsEvents,
	IWallet,
	MappedRecord,
	SignedTxData,
	TxParams,
} from '../types';
import { containsComputeUnitIxs } from '../util/computeUnits';
import { CachedBlockhashFetcher } from './blockhashFetcher/cachedBlockhashFetcher';
import { BaseBlockhashFetcher } from './blockhashFetcher/baseBlockhashFetcher';
import { BlockhashFetcher } from './blockhashFetcher/types';
import { getCombinedInstructions, isVersionedTransaction } from './utils';
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

export type TxBuildingProps = {
	instructions: TransactionInstruction | TransactionInstruction[];
	txVersion: TransactionVersion;
	connection: Connection;
	preFlightCommitment: Commitment;
	fetchMarketLookupTableAccount: () => Promise<AddressLookupTableAccount>;
	lookupTables?: AddressLookupTableAccount[];
	forceVersionedTransaction?: boolean;
	txParams?: TxParams;
	recentBlockhash?: BlockhashWithExpiryBlockHeight;
	wallet?: IWallet;
	optionalIxs?: TransactionInstruction[]; // additional instructions to add to the front of ixs if there's enough room, such as oracle cranks
};

export type TxHandlerConfig = {
	blockhashCachingEnabled?: boolean;
	blockhashCachingConfig?: {
		retryCount: number;
		retrySleepTimeMs: number;
		staleCacheTimeMs: number;
	};
};

/**
 * This class is responsible for creating and signing transactions.
 */
export class TxHandler {
	private blockHashToLastValidBlockHeightLookup: Record<string, number> = {};
	private returnBlockHeightsWithSignedTxCallbackData = false;

	private connection: Connection;
	private wallet: IWallet;
	private confirmationOptions: ConfirmOptions;

	private preSignedCb?: () => void;
	private onSignedCb?: (txSigs: DriftClientMetricsEvents['txSigned']) => void;

	private blockhashCommitment: Commitment =
		DEFAULT_CONFIRMATION_OPTS.commitment;
	private blockHashFetcher: BlockhashFetcher;

	constructor(props: {
		connection: Connection;
		wallet: IWallet;
		confirmationOptions: ConfirmOptions;
		opts?: {
			returnBlockHeightsWithSignedTxCallbackData?: boolean;
			onSignedCb?: (txSigs: DriftClientMetricsEvents['txSigned']) => void;
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

	public updateWallet(wallet: IWallet) {
		this.wallet = wallet;
	}

	/**
	 * Created this to prevent non-finalized blockhashes being used when building transactions. We want to always use finalized because otherwise it's easy to get the BlockHashNotFound error (RPC uses finalized to validate a transaction). Using an older blockhash when building transactions should never really be a problem right now.
	 *
	 * https://www.helius.dev/blog/how-to-deal-with-blockhash-errors-on-solana#why-do-blockhash-errors-occur
	 *
	 * @returns
	 */
	public async getLatestBlockhashForTransaction() {
		return this.blockHashFetcher.getLatestBlockhash();
	}

	/**
	 * Applies recent blockhash and signs a given transaction
	 * @param tx
	 * @param additionalSigners
	 * @param wallet
	 * @param confirmationOpts
	 * @param preSigned
	 * @param recentBlockhash
	 * @returns
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
		recentBlockhash = recentBlockhash
			? recentBlockhash
			: await this.getLatestBlockhashForTransaction();
		tx.recentBlockhash = recentBlockhash.blockhash;

		this.addHashAndExpiryToLookup(recentBlockhash);

		const signedTx = await this.signTx(tx, additionalSigners);

		// @ts-ignore
		signedTx.SIGNATURE_BLOCK_AND_EXPIRY = recentBlockhash;

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
			return bs58.encode(
				Buffer.from((signedTx as Transaction).signature)
			) as string;
		}
	}

	private getBlockhashFromSignedTx(
		signedTx: Transaction | VersionedTransaction
	) {
		if (this.isVersionedTransaction(signedTx)) {
			return (signedTx as VersionedTransaction).message.recentBlockhash;
		} else {
			return (signedTx as Transaction).recentBlockhash;
		}
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
	) {
		if (!this.returnBlockHeightsWithSignedTxCallbackData) {
			if (this.onSignedCb) {
				this.onSignedCb(txData);
			}

			return;
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
					txBuildingProps.txParams.useSimulatedComputeUnits,
				computeUnitsBufferMultiplier:
					txBuildingProps.txParams.computeUnitsBufferMultiplier,
				useSimulatedComputeUnitsForCUPriceCalculation:
					txBuildingProps.txParams
						.useSimulatedComputeUnitsForCUPriceCalculation,
				getCUPriceFromComputeUnits:
					txBuildingProps.txParams.getCUPriceFromComputeUnits,
			},
			processParams: {
				connection: this.connection,
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
	 * @param props
	 * @returns
	 */
	public async buildBulkTransactions(
		props: Omit<TxBuildingProps, 'instructions'> & {
			instructions: (TransactionInstruction | TransactionInstruction[])[];
		}
	) {
		const recentBlockhash =
			props?.recentBlockhash ?? (await this.getLatestBlockhashForTransaction());

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
	 *
	 * @param instructions
	 * @param txParams
	 * @param txVersion
	 * @param lookupTables
	 * @param forceVersionedTransaction Return a VersionedTransaction instance even if the version of the transaction is Legacy
	 * @returns
	 */
	public async buildTransaction(
		props: TxBuildingProps
	): Promise<Transaction | VersionedTransaction> {
		const {
			txVersion,
			txParams,
			connection: _connection,
			preFlightCommitment: _preFlightCommitment,
			fetchMarketLookupTableAccount,
			forceVersionedTransaction,
			instructions,
		} = props;

		let { lookupTables } = props;

		// # Collect and process Tx Params
		let baseTxParams: BaseTxParams = {
			computeUnits: txParams?.computeUnits,
			computeUnitsPrice: txParams?.computeUnitsPrice,
		};

		const instructionsArray = Array.isArray(instructions)
			? instructions
			: [instructions];

		let instructionsToUse: TransactionInstruction[];

		// add optional ixs if there's room (usually oracle cranks)
		if (props.optionalIxs && txVersion === 0) {
			instructionsToUse = getCombinedInstructions(
				instructionsArray,
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
		if (computeUnits > 0 && !hasSetComputeUnitLimitIx) {
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
		} else if (computeUnitsPrice > 0 && !hasSetComputeUnitPriceIx) {
			allIx.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: computeUnitsPrice,
				})
			);
		}

		allIx.push(...instructionsToUse);

		const recentBlockhash =
			props?.recentBlockhash ?? (await this.getLatestBlockhashForTransaction());

		// # Create and return Transaction
		if (txVersion === 'legacy') {
			if (forceVersionedTransaction) {
				return this.generateLegacyVersionedTransaction(recentBlockhash, allIx);
			} else {
				return this.generateLegacyTransaction(allIx, recentBlockhash);
			}
		} else {
			const marketLookupTable = await fetchMarketLookupTableAccount();
			lookupTables = lookupTables
				? [...lookupTables, marketLookupTable]
				: [marketLookupTable];

			return this.generateVersionedTransaction(
				recentBlockhash,
				allIx,
				lookupTables
			);
		}
	}

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
	 * @param txsToSign
	 * @param keys
	 * @param wallet
	 * @param commitment
	 * @returns
	 */
	public async getPreparedAndSignedLegacyTransactionMap<
		T extends Record<string, Transaction | undefined>,
	>(
		txsMap: T,
		wallet?: IWallet,
		commitment?: Commitment,
		recentBlockhash?: BlockhashWithExpiryBlockHeight
	) {
		recentBlockhash = recentBlockhash
			? recentBlockhash
			: await this.getLatestBlockhashForTransaction();

		this.addHashAndExpiryToLookup(recentBlockhash);

		for (const tx of Object.values(txsMap)) {
			if (!tx) continue;
			tx.recentBlockhash = recentBlockhash.blockhash;
			tx.feePayer = wallet?.publicKey ?? this.wallet?.publicKey;

			// @ts-ignore
			tx.SIGNATURE_BLOCK_AND_EXPIRY = recentBlockhash;
		}

		return this.getSignedTransactionMap(txsMap, wallet);
	}

	/**
	 * Get a map of signed transactions from an array of transactions to sign.
	 * @param txsToSign
	 * @param keys
	 * @param wallet
	 * @returns
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
		const signedTxMap = txsToSignEntries.reduce((acc, [key]) => {
			acc[key] = undefined;
			return acc;
		}, {}) as T;

		const filteredTxEntries = txsToSignEntries.filter(([_, tx]) => !!tx);

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
	 * @param props
	 * @returns
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

		return Object.keys(props.instructionsMap).reduce((acc, key, index) => {
			acc[key] = builtTxs[index];
			return acc;
		}, {}) as MappedRecord<T, Transaction | VersionedTransaction>;
	}

	/**
	 * Builds and signs transactions from a given array of instructions for multiple transactions.
	 * @param props
	 * @returns
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
}
