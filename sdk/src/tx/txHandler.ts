import { BaseTxParams, IWallet, TxParams } from '@drift-labs/sdk';
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
import { DriftClientMetricsEvents, SignedTxData } from '../types';

export const COMPUTE_UNITS_DEFAULT = 200_000;

export type TxBuildingProps = {
	instructions: TransactionInstruction | TransactionInstruction[];
	txVersion: TransactionVersion;
	connection: Connection;
	preFlightCommitment: Commitment;
	fetchMarketLookupTableAccount: () => Promise<AddressLookupTableAccount>;
	lookupTables?: AddressLookupTableAccount[];
	forceVersionedTransaction?: boolean;
	txParams?: TxParams;
	recentBlockHash?: BlockhashWithExpiryBlockHeight;
	wallet?: IWallet;
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

	constructor(props: {
		connection: Connection;
		wallet: IWallet;
		confirmationOptions: ConfirmOptions;
		opts?: {
			returnBlockHeightsWithSignedTxCallbackData?: boolean;
			onSignedCb?: (txSigs: DriftClientMetricsEvents['txSigned']) => void;
			preSignedCb?: () => void;
		};
	}) {
		this.connection = props.connection;
		this.wallet = props.wallet;
		this.confirmationOptions = props.confirmationOptions;

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
	public getLatestBlockhashForTransaction() {
		return this.connection.getLatestBlockhash('finalized');
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

		return signedTx;
	}

	private isVersionedTransaction(tx: Transaction | VersionedTransaction) {
		return (tx as VersionedTransaction)?.message && true;
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
		recentBlockHash?: BlockhashWithExpiryBlockHeight,
		wallet?: IWallet
	): Promise<VersionedTransaction> {
		[wallet] = this.getProps(wallet);

		if (recentBlockHash) {
			tx.message.recentBlockhash = recentBlockHash.blockhash;

			this.addHashAndExpiryToLookup(recentBlockHash);
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

		const fullTxData = txData.map((tx) => {
			const lastValidBlockHeight =
				this.blockHashToLastValidBlockHeightLookup[tx.blockHash];

			return {
				...tx,
				lastValidBlockHeight,
			};
		});

		if (this.onSignedCb) {
			this.onSignedCb(fullTxData);
		}
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
		recentBlockHash: BlockhashWithExpiryBlockHeight,
		message: Message | MessageV0
	) {
		this.addHashAndExpiryToLookup(recentBlockHash);

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

		return this._generateVersionedTransaction(recentBlockhash, message);
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

		return this._generateVersionedTransaction(recentBlockhash, message);
	}

	public generateLegacyTransaction(ixs: TransactionInstruction[]) {
		return new Transaction().add(...ixs);
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
		const recentBlockHash =
			props?.recentBlockHash ?? (await this.getLatestBlockhashForTransaction());

		return await Promise.all(
			props.instructions.map((ix) => {
				if (!ix) return undefined;
				return this.buildTransaction({
					...props,
					instructions: ix,
					recentBlockHash,
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
			instructions,
			txVersion,
			txParams,
			connection: _connection,
			preFlightCommitment: _preFlightCommitment,
			fetchMarketLookupTableAccount,
			forceVersionedTransaction,
		} = props;

		let { lookupTables } = props;

		// # Collect and process Tx Params
		let baseTxParams: BaseTxParams = {
			computeUnits: txParams?.computeUnits,
			computeUnitsPrice: txParams?.computeUnitsPrice,
		};

		if (txParams?.useSimulatedComputeUnits) {
			const processedTxParams = await this.getProcessedTransactionParams(props);

			baseTxParams = {
				...baseTxParams,
				...processedTxParams,
			};
		}

		// # Create Tx Instructions
		const allIx = [];
		const computeUnits = baseTxParams?.computeUnits;
		if (computeUnits !== 200_000) {
			allIx.push(
				ComputeBudgetProgram.setComputeUnitLimit({
					units: computeUnits,
				})
			);
		}

		const computeUnitsPrice = baseTxParams?.computeUnitsPrice;

		if (computeUnitsPrice !== 0) {
			allIx.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: computeUnitsPrice,
				})
			);
		}

		if (Array.isArray(instructions)) {
			allIx.push(...instructions);
		} else {
			allIx.push(instructions);
		}

		const recentBlockHash =
			props?.recentBlockHash ?? (await this.getLatestBlockhashForTransaction());

		// # Create and return Transaction
		if (txVersion === 'legacy') {
			if (forceVersionedTransaction) {
				return this.generateLegacyVersionedTransaction(recentBlockHash, allIx);
			} else {
				return this.generateLegacyTransaction(allIx);
			}
		} else {
			const marketLookupTable = await fetchMarketLookupTableAccount();

			lookupTables = lookupTables
				? [...lookupTables, marketLookupTable]
				: [marketLookupTable];

			return this.generateVersionedTransaction(
				recentBlockHash,
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

		if (computeUnitsPrice != 0) {
			tx.add(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: computeUnitsPrice,
				})
			);
		}

		return tx.add(instruction);
	}

	/**
	 * Build a map of transactions from an array of instructions for multiple transactions.
	 * @param txsToSign
	 * @param keys
	 * @param wallet
	 * @param commitment
	 * @returns
	 */
	public async buildTransactionMap(
		txsToSign: (Transaction | undefined)[],
		keys: string[],
		wallet?: IWallet,
		commitment?: Commitment,
		recentBlockHash?: BlockhashWithExpiryBlockHeight
	) {
		recentBlockHash = recentBlockHash
			? recentBlockHash
			: await this.getLatestBlockhashForTransaction();

		this.addHashAndExpiryToLookup(recentBlockHash);

		for (const tx of txsToSign) {
			if (!tx) continue;
			tx.recentBlockhash = recentBlockHash.blockhash;
			tx.feePayer = wallet?.publicKey ?? this.wallet?.publicKey;
		}

		return this.getSignedTransactionMap(txsToSign, keys, wallet);
	}

	/**
	 * Get a map of signed and prepared transactions from an array of legacy transactions
	 * @param txsToSign
	 * @param keys
	 * @param wallet
	 * @param commitment
	 * @returns
	 */
	public async getPreparedAndSignedLegacyTransactionMap(
		txsToSign: (Transaction | undefined)[],
		keys: string[],
		wallet?: IWallet,
		commitment?: Commitment,
		recentBlockHash?: BlockhashWithExpiryBlockHeight
	) {
		recentBlockHash = recentBlockHash
			? recentBlockHash
			: await this.getLatestBlockhashForTransaction();

		this.addHashAndExpiryToLookup(recentBlockHash);

		for (const tx of txsToSign) {
			if (!tx) continue;
			tx.recentBlockhash = recentBlockHash.blockhash;
			tx.feePayer = wallet?.publicKey ?? this.wallet?.publicKey;
		}

		return this.getSignedTransactionMap(txsToSign, keys, wallet);
	}

	/**
	 * Get a map of signed transactions from an array of transactions to sign.
	 * @param txsToSign
	 * @param keys
	 * @param wallet
	 * @returns
	 */
	public async getSignedTransactionMap(
		txsToSign: (Transaction | VersionedTransaction | undefined)[],
		keys: string[],
		wallet?: IWallet
	): Promise<{
		[key: string]: Transaction | VersionedTransaction | undefined;
	}> {
		[wallet] = this.getProps(wallet);

		const signedTxMap: {
			[key: string]: Transaction | VersionedTransaction | undefined;
		} = {};

		const keysWithTx = [];
		txsToSign.forEach((tx, index) => {
			if (tx == undefined) {
				signedTxMap[keys[index]] = undefined;
			} else {
				keysWithTx.push(keys[index]);
			}
		});

		this.preSignedCb?.();

		const signedTxs = await wallet.signAllTransactions(
			txsToSign
				.map((tx) => {
					return tx as Transaction;
				})
				.filter((tx) => tx !== undefined)
		);

		this.handleSignedTxData(
			signedTxs.map((signedTx) => {
				return {
					txSig: this.getTxSigFromSignedTx(signedTx),
					signedTx,
					blockHash: this.getBlockhashFromSignedTx(signedTx),
				};
			})
		);

		signedTxs.forEach((signedTx, index) => {
			signedTxMap[keysWithTx[index]] = signedTx;
		});

		return signedTxMap;
	}

	/**
	 * Builds and signs transactions from a given array of instructions for multiple transactions.
	 * @param props
	 * @returns
	 */
	public async buildAndSignTransactionMap(
		props: Omit<TxBuildingProps, 'instructions'> & {
			keys: string[];
			instructions: (TransactionInstruction | TransactionInstruction[])[];
		}
	) {
		const transactions = await this.buildBulkTransactions(props);

		const preppedTransactions =
			props.txVersion === 'legacy'
				? this.getPreparedAndSignedLegacyTransactionMap(
						transactions as Transaction[],
						props.keys,
						props.wallet,
						props.preFlightCommitment
				  )
				: this.getSignedTransactionMap(transactions, props.keys, props.wallet);

		return preppedTransactions;
	}
}
