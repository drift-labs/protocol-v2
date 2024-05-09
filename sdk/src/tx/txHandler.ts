import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { BaseTxParams, ProcessingTxParams, TxParams } from "@drift-labs/sdk";
import { AddressLookupTableAccount, Commitment, ComputeBudgetProgram, ConfirmOptions, Connection, Message, MessageV0, Signer, Transaction, TransactionInstruction, TransactionMessage, TransactionVersion, VersionedTransaction } from "@solana/web3.js";
import { TransactionProcessor } from "./txParamProcessor";
import bs58 from 'bs58';
import { BlockHashAndValidSlot } from "./types";

export const COMPUTE_UNITS_DEFAULT = 200_000;

export type PreTxData = {
    txSig: string;
    signedTx: Transaction | VersionedTransaction,
	blockHash: string,
}

export type PostTxData = {
    txSig: string;
    signedTx: Transaction | VersionedTransaction,
    lastValidBlockHeight?: number,
	blockHash: string,
}

export type TxBuildingProps = {
    instructions: TransactionInstruction | TransactionInstruction[],
    txVersion: TransactionVersion,
    connection: Connection,
    provider: AnchorProvider,
    preFlightCommitment: Commitment,
    fetchMarketLookupTableAccount: () => Promise<AddressLookupTableAccount>,
    lookupTables?: AddressLookupTableAccount[],
    forceVersionedTransaction?: boolean
    txParams?: TxParams,
};

/**
 * This class is responsible for creating and signing transactions.
 */
export class TxHandler {

    public readonly signedTxData: Record<string, PostTxData> = {};
    private blockHashToLastValidBlockHeightLookup: Record<string, number> = {};
    private storeSignedTxData = false;
    private confirmOptions: ConfirmOptions;
    private connection: Connection;
    private provider: AnchorProvider;
    private onSignedCb?: () => void;

    constructor(
        props : {
            confirmOptions: ConfirmOptions,
            connection: Connection,
            provider: AnchorProvider,
            opts?: {
                storeSignedTxData?: boolean;
                onSignedCb?: () => void;
            }
        },
    ) {
        this.confirmOptions = props.confirmOptions;
        this.connection = props.connection;
        this.storeSignedTxData = props.opts?.storeSignedTxData ?? false;
        this.provider = props.provider;
        this.onSignedCb = props.opts?.onSignedCb;
    }
    
    public async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions,
		preSigned?: boolean,
        latestBlockhash?: {
            blockhash: string;
            lastValidBlockHeight: number;
        }
	): Promise<Transaction> {
		if (preSigned) {
			return tx;
		}

		tx.feePayer = this.provider.wallet.publicKey;
		const recentBlockhash = latestBlockhash ? latestBlockhash : (
			await this.connection.getLatestBlockhash(opts.preflightCommitment)
		);
		tx.recentBlockhash = recentBlockhash.blockhash;

        this.blockHashToLastValidBlockHeightLookup[recentBlockhash.blockhash] = recentBlockhash.lastValidBlockHeight;

		const signedTx = await this.signTx(tx, additionalSigners);

		return signedTx;
	}

    public async signTx(
		tx: Transaction,
        additionalSigners: Array<Signer>,
	): Promise<Transaction> {

        additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});
            
		const signedTx = await this.provider.wallet.signTransaction(tx);

        // Turn txSig Buffer into base58 string
        const txSigBuffer = Buffer.from(signedTx.signature);
        const txSig = bs58.encode(txSigBuffer) as string;

        this.handleSignedTxData([
            {
                txSig,
                signedTx,
                blockHash: tx.recentBlockhash,
            }
        ]);

		return signedTx;
	}

    async signVersionedTx(
		tx: VersionedTransaction,
        additionalSigners: Array<Signer>,
        latestBlockhashOverride?: {
            blockhash: string;
            lastValidBlockHeight: number;
        }
	): Promise<VersionedTransaction> {

        if (latestBlockhashOverride) {
            tx.message.recentBlockhash = latestBlockhashOverride.blockhash;

            this.blockHashToLastValidBlockHeightLookup[latestBlockhashOverride.blockhash] = latestBlockhashOverride.lastValidBlockHeight;
        }

        additionalSigners
            ?.filter((s): s is Signer => s !== undefined)
            .forEach((kp) => {
                tx.sign([kp]);
            });
            
		const signedTx = await this.provider.wallet.signTransaction(tx);

        // Turn txSig Buffer into base58 string
        const txSigBuffer = Buffer.from(signedTx.signatures[0]);
        const txSig = bs58.encode(txSigBuffer) as string;

        this.handleSignedTxData([
            {
                txSig,
                signedTx,
                blockHash: tx.message.recentBlockhash,
            }
        ]);

		return signedTx;
	}

    private handleSignedTxData(txData: PreTxData[]) {
        if (!this.storeSignedTxData) {
            return;
        }

        txData.forEach((tx) => {
            const lastValidBlockHeight = this.blockHashToLastValidBlockHeightLookup[tx.blockHash];

            this.signedTxData[tx.txSig] = {
                ...tx,
                lastValidBlockHeight
            };
        });

        if (this.onSignedCb) {
            this.onSignedCb();
        }
    }

    private async getProcessedTransactionParams(
		txParams: TxBuildingProps,
		txParamProcessingParams: ProcessingTxParams
	): Promise<BaseTxParams> {
		const tx = await TransactionProcessor.process({
			txProps: {
				instructions: txParams.instructions,
				txParams: txParams.txParams,
				txVersion: txParams.txVersion,
				lookupTables: txParams.lookupTables,
			},
			txBuilder: (updatedTxParams) =>
				this.buildTransaction({
                    ...txParams,
                    instructions: updatedTxParams.instructions,
                    txParams: updatedTxParams?.txParams,
                    txVersion: updatedTxParams.txVersion,
                    lookupTables: updatedTxParams.lookupTables,
                    forceVersionedTransaction: true,
                }) as Promise<VersionedTransaction>,
			processConfig: txParamProcessingParams,
			processParams: {
				connection: txParams.connection,
			},
		});

		return tx;
	}

    private _generateVersionedTransaction(
        recentBlockHashAndLastValidBlockHeight: BlockHashAndValidSlot,
        message: Message | MessageV0
    ) {
        this.blockHashToLastValidBlockHeightLookup[recentBlockHashAndLastValidBlockHeight.blockhash] = recentBlockHashAndLastValidBlockHeight.lastValidBlockHeight;
        
        return new VersionedTransaction(message);
    }

    public generateLegacyVersionedTransaction(
        recentBlockHashAndLastValidBlockHeight: BlockHashAndValidSlot,
        ixs: TransactionInstruction[],
    ) {
        const message = new TransactionMessage({
			payerKey: this.provider.wallet.publicKey,
			recentBlockhash: recentBlockHashAndLastValidBlockHeight.blockhash,
			instructions: ixs,
		}).compileToLegacyMessage();

		return this._generateVersionedTransaction(recentBlockHashAndLastValidBlockHeight, message);
    }

    public generateVersionedTransaction(
        recentBlockHashAndLastValidBlockHeight:{
            blockhash: string;
            lastValidBlockHeight: number;
        },
        ixs: TransactionInstruction[],
        lookupTableAccounts: AddressLookupTableAccount[]
    ) {
        const message = new TransactionMessage({
			payerKey: this.provider.wallet.publicKey,
			recentBlockhash: recentBlockHashAndLastValidBlockHeight.blockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		return this._generateVersionedTransaction(recentBlockHashAndLastValidBlockHeight, message);
    }

    public generateLegacyTransaction(ixs: TransactionInstruction[]) {
        return new Transaction().add(...ixs);
    }

    public async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
        blockHashAndLastValidBlockHeight?: BlockHashAndValidSlot
	): Promise<VersionedTransaction> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.confirmOptions;
		}

		if (!blockHashAndLastValidBlockHeight) {
			blockHashAndLastValidBlockHeight = (
				await this.connection.getLatestBlockhash(opts.preflightCommitment)
			);
		}

        const tx = this.generateVersionedTransaction(
            blockHashAndLastValidBlockHeight,
            ixs,
            lookupTableAccounts
        );

		return tx;
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
        props : TxBuildingProps
    ): Promise<Transaction | VersionedTransaction> {

        const {
            instructions,
            txVersion,
            txParams,
            connection,
            preFlightCommitment,
            fetchMarketLookupTableAccount,
            forceVersionedTransaction,
        } = props;

        let { lookupTables } = props;

		// # Collect and process Tx Params
		let baseTxParams: BaseTxParams = {
			computeUnits: txParams?.computeUnits,
			computeUnitsPrice:
				txParams?.computeUnitsPrice,
		};

		if (txParams?.useSimulatedComputeUnits) {
			const splitTxParams: {
				baseTxParams: BaseTxParams;
				txParamProcessingParams: ProcessingTxParams;
			} = {
				baseTxParams: {
					computeUnits: txParams?.computeUnits,
					computeUnitsPrice: txParams?.computeUnitsPrice,
				},
				txParamProcessingParams: {
					useSimulatedComputeUnits: txParams?.useSimulatedComputeUnits,
					computeUnitsBufferMultiplier: txParams?.computeUnitsBufferMultiplier,
					useSimulatedComputeUnitsForCUPriceCalculation:
						txParams?.useSimulatedComputeUnitsForCUPriceCalculation,
					getCUPriceFromComputeUnits: txParams?.getCUPriceFromComputeUnits,
				},
			};

			const processedTxParams = await this.getProcessedTransactionParams(
				props,
				splitTxParams.txParamProcessingParams
			);

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

		const latestBlockHashAndContext =
			await connection.getLatestBlockhashAndContext({
				commitment: preFlightCommitment,
			});

		// # Create and return Transaction
		if (txVersion === 'legacy') {
			if (forceVersionedTransaction) {
				return this.generateLegacyVersionedTransaction(
                    latestBlockHashAndContext.value,
                    allIx
                );
			} else {
				return this.generateLegacyTransaction(allIx);
			}
		} else {
			const marketLookupTable = await fetchMarketLookupTableAccount();
            
			lookupTables = lookupTables
				? [...lookupTables, marketLookupTable]
				: [marketLookupTable];

            return this.generateVersionedTransaction(
                latestBlockHashAndContext.value,
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

    /* Helper function for signing multiple transactions where some may be undefined and mapping the output */
    public async getSignedTransactionMap(
        wallet: Wallet,
        txsToSign: (Transaction | VersionedTransaction | undefined)[],
        keys: string[]
    ): Promise<{ [key: string]: Transaction | VersionedTransaction | undefined }> {
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

        const signedTxs = await wallet.signAllTransactions(
            txsToSign
                .map((tx) => {
                    return tx as Transaction;
                })
                .filter((tx) => tx !== undefined)
        );

        signedTxs.forEach((signedTx, index) => {
            signedTxMap[keysWithTx[index]] = signedTx;
        });

        return signedTxMap;
    }
}