import { AnchorProvider } from "@coral-xyz/anchor";
import { BaseTxParams, TxParams } from "@drift-labs/sdk";
import { AddressLookupTableAccount, BlockhashWithExpiryBlockHeight, Commitment, ComputeBudgetProgram, ConfirmOptions, Connection, Message, MessageV0, Signer, Transaction, TransactionInstruction, TransactionMessage, TransactionVersion, VersionedTransaction } from "@solana/web3.js";
import { TransactionParamProcessor } from "./txParamProcessor";
import bs58 from 'bs58';
import { DriftClientMetricsEvents, SignedTxData } from "../types";
import { Wallet } from "../wallet";

export const COMPUTE_UNITS_DEFAULT = 200_000;

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

    private blockHashToLastValidBlockHeightLookup: Record<string, number> = {};
    private returnBlockHeightsWithSignedTxCallbackData = false;

    private connection: Connection;
    private wallet: Wallet;
    private confirmationOptions: ConfirmOptions;

    private onSignedCb?: (txSigs: DriftClientMetricsEvents['txSigned']) => void;

    constructor(
        props : {
            connection: Connection,
            wallet: Wallet,
            confirmationOptions: ConfirmOptions,
            opts?: {
                returnBlockHeightsWithSignedTxCallbackData?: boolean;
                onSignedCb?: (txSigs: DriftClientMetricsEvents['txSigned']) => void;
            }
        },
    ) {
        this.connection = props.connection;
        this.wallet = props.wallet;
        this.confirmationOptions = props.confirmationOptions;

        // #Optionals
        this.returnBlockHeightsWithSignedTxCallbackData = props.opts?.returnBlockHeightsWithSignedTxCallbackData ?? false;
        this.onSignedCb = props.opts?.onSignedCb;
    }

    private addHashAndExpiryToLookup(hashAndExpiry: BlockhashWithExpiryBlockHeight) {
        if (!this.returnBlockHeightsWithSignedTxCallbackData) return;

        this.blockHashToLastValidBlockHeightLookup[hashAndExpiry.blockhash] = hashAndExpiry.lastValidBlockHeight;
    }

    private getProps = (wallet?:Wallet,  confirmationOpts?: ConfirmOptions) => [
        wallet ?? this.wallet,
        confirmationOpts ?? this.confirmationOptions
    ] as [
        Wallet,
        ConfirmOptions
    ]

    public updateWallet(wallet: Wallet) {
        this.wallet = wallet;
    }
    
    /**
     * Applies recent blockhash and signs a given transaction
     * @param tx 
     * @param additionalSigners 
     * @param wallet 
     * @param confirmationOpts 
     * @param preSigned 
     * @param latestBlockhash 
     * @returns 
     */
    public async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
        wallet?: Wallet,
		confirmationOpts?: ConfirmOptions,
		preSigned?: boolean,
        latestBlockhash?: BlockhashWithExpiryBlockHeight
	): Promise<Transaction> {
		if (preSigned) {
			return tx;
		}

        [wallet, confirmationOpts] = this.getProps(wallet, confirmationOpts);

		tx.feePayer = wallet.publicKey;
		const recentBlockhash = latestBlockhash ? latestBlockhash : (
			await this.connection.getLatestBlockhash(confirmationOpts.preflightCommitment)
		);
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
            return bs58.encode(Buffer.from((signedTx as VersionedTransaction).signatures[0])) as string;
        } else {
            return bs58.encode(Buffer.from((signedTx as Transaction).signature)) as string;
        }
    }
    
    private getBlockhashFromSignedTx(signedTx: Transaction | VersionedTransaction) {
        if (this.isVersionedTransaction(signedTx)) {
            return (signedTx as VersionedTransaction).message.recentBlockhash;
        } else {
            return (signedTx as Transaction).recentBlockhash;
        }
    }

    private async signTx(
		tx: Transaction,
        additionalSigners: Array<Signer>,
        wallet?: Wallet,
	): Promise<Transaction> {

        [wallet] = this.getProps(wallet);

        additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});
            
		const signedTx = await wallet.signTransaction(tx);

        // Turn txSig Buffer into base58 string
        const txSig = this.getTxSigFromSignedTx(signedTx);

        this.handleSignedTxData([
            {
                txSig,
                signedTx,
                blockHash: this.getBlockhashFromSignedTx(signedTx),
            }
        ]);

		return signedTx;
	}

    public async signVersionedTx(
		tx: VersionedTransaction,
        additionalSigners: Array<Signer>,
        latestBlockhashOverride?: BlockhashWithExpiryBlockHeight,
        wallet?: Wallet,
	): Promise<VersionedTransaction> {

        [wallet] = this.getProps(wallet);

        if (latestBlockhashOverride) {
            tx.message.recentBlockhash = latestBlockhashOverride.blockhash;

            this.addHashAndExpiryToLookup(latestBlockhashOverride);
        }

        additionalSigners
            ?.filter((s): s is Signer => s !== undefined)
            .forEach((kp) => {
                tx.sign([kp]);
            });
            
		const signedTx = await wallet.signVersionedTransaction(tx);

        // Turn txSig Buffer into base58 string
        const txSig = this.getTxSigFromSignedTx(signedTx);

        this.handleSignedTxData([
            {
                txSig,
                signedTx,
                blockHash: this.getBlockhashFromSignedTx(signedTx),
            }
        ]);

		return signedTx;
	}

    private handleSignedTxData(txData: Omit<SignedTxData, 'lastValidBlockHeight'>[]) {
        if (!this.returnBlockHeightsWithSignedTxCallbackData) {
            
            if (this.onSignedCb) {
                this.onSignedCb(txData);
            }

            return;
        }

        const fullTxData = txData.map((tx) => {
            const lastValidBlockHeight = this.blockHashToLastValidBlockHeightLookup[tx.blockHash];

            return {
                ...tx,
                lastValidBlockHeight
            };
        });

        if (this.onSignedCb) {
            this.onSignedCb(fullTxData);
        }
    }

    private async getProcessedTransactionParams(
		txBuildingProps: TxBuildingProps,
	): Promise<BaseTxParams> {

        const baseTxParams : BaseTxParams = {
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
                useSimulatedComputeUnits: txBuildingProps.txParams.useSimulatedComputeUnits,
                computeUnitsBufferMultiplier: txBuildingProps.txParams.computeUnitsBufferMultiplier,
                useSimulatedComputeUnitsForCUPriceCalculation: txBuildingProps.txParams.useSimulatedComputeUnitsForCUPriceCalculation,
                getCUPriceFromComputeUnits: txBuildingProps.txParams.getCUPriceFromComputeUnits,
            },
			processParams: {
				connection: this.connection,
			},
		});

		return processedTxParams;
	}

    private _generateVersionedTransaction(
        recentBlockHashAndLastValidBlockHeight: BlockhashWithExpiryBlockHeight,
        message: Message | MessageV0
    ) {
        this.addHashAndExpiryToLookup(recentBlockHashAndLastValidBlockHeight);
        
        return new VersionedTransaction(message);
    }

    public generateLegacyVersionedTransaction(
        recentBlockHashAndLastValidBlockHeight: BlockhashWithExpiryBlockHeight,
        ixs: TransactionInstruction[],
        wallet?: Wallet
    ) {
        [wallet] = this.getProps(wallet);

        const message = new TransactionMessage({
			payerKey: wallet.publicKey,
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
        lookupTableAccounts: AddressLookupTableAccount[],
        wallet?: Wallet
    ) {
        [wallet] = this.getProps(wallet);

        const message = new TransactionMessage({
			payerKey: wallet.publicKey,
			recentBlockhash: recentBlockHashAndLastValidBlockHeight.blockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		return this._generateVersionedTransaction(recentBlockHashAndLastValidBlockHeight, message);
    }

    public generateLegacyTransaction(ixs: TransactionInstruction[]) {
        return new Transaction().add(...ixs);
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
			
			const processedTxParams = await this.getProcessedTransactionParams(
                props,
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

    public async getSignedTransactionMap(
        txsToSign: (Transaction | VersionedTransaction | undefined)[],
        keys: string[],
        wallet?: Wallet,
    ): Promise<{ [key: string]: Transaction | VersionedTransaction | undefined }> {

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
}