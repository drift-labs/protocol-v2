import { AddressLookupTableAccount, Connection, RpcResponseAndContext, SimulatedTransactionResponse, TransactionInstruction, TransactionVersion, VersionedTransaction } from "@solana/web3.js";
import { BaseTxParams, ProcessingTxParams } from "..";

const COMPUTE_UNIT_BUFFER_FACTOR = 1.2;

const TEST_SIMS_ALWAYS_FAIL = false;

type TransactionProps = {
    instructions: TransactionInstruction | TransactionInstruction[],
    txParams?: BaseTxParams,
    txVersion?: TransactionVersion,
    lookupTables?: AddressLookupTableAccount[]
}

/**
 * This class is responsible for running through a "processing" pipeline for a base transaction, to adjust the standard transaction parameters based on a given configuration.
 */
export class TransactionProcessor {

    private static async getComputeUnitsFromSim (
		txSim: RpcResponseAndContext<SimulatedTransactionResponse>
	) {
		if (txSim?.value?.unitsConsumed) {
			return txSim?.value?.unitsConsumed * COMPUTE_UNIT_BUFFER_FACTOR;
		} 

		return undefined;
	}

	public static async getTxSimComputeUnits(
		tx : VersionedTransaction,
        connection: Connection
	) : Promise<{success: boolean, computeUnits: number}>{
		try {

            if (TEST_SIMS_ALWAYS_FAIL) throw new Error('Test Error::SIMS_ALWAYS_FAIL');

            // @ts-ignore
            const version = tx?.version;

            let simTxResult : RpcResponseAndContext<SimulatedTransactionResponse>;

            if (version === undefined || version==='legacy') {
                console.debug(`🔧:: Running Simulation for LEGACY TX`);
                simTxResult = (await connection.simulateTransaction(
                    tx
                ));
            } else {
                console.debug(`🔧:: Running Simulation for VERSIONED TX`);
                simTxResult = (await connection.simulateTransaction(
                    tx,
                ));
            }

			const computeUnits = await this.getComputeUnitsFromSim(
				simTxResult
			);

            return {
                success: true,
                computeUnits: computeUnits
            };
		} catch (e) {
			return {
                success: false,
                computeUnits: undefined
            };
		}
	}

    static async process(
        props : {
            txProps: TransactionProps,
            txBuilder: (baseTransactionProps: TransactionProps) => Promise<VersionedTransaction>,
            processConfig: ProcessingTxParams,
            processParams: {
                connection : Connection
            }
        }
    ) {
        const {
            txProps: transactionProps,
            txBuilder: transactionBuilder,
            processConfig,
            processParams: processProps
        } = props;

        if (!processConfig || Object.keys(processConfig).length===0) {
            return transactionBuilder(transactionProps);
        }

        // # Setup
        const baseTransaction = await transactionBuilder(transactionProps);
        let baseTransactionHasChanged = false;

        let txToReturn = baseTransaction;

        const finalTxProps = {
            ...transactionProps
        };

        // # Run Processes
        if (processConfig.useSimulatedComputeUnits) {

            const txSimComputeUnitsResult = await this.getTxSimComputeUnits(
                baseTransaction as VersionedTransaction,
                processProps.connection
            );

            if (txSimComputeUnitsResult.success && txSimComputeUnitsResult.computeUnits!==transactionProps?.txParams?.computeUnits) {
                // Adjust the transaction based on the simulated compute units
                finalTxProps.txParams = {
                    ...transactionProps.txParams,
                    computeUnits: txSimComputeUnitsResult.computeUnits
                };
                baseTransactionHasChanged = true;

                console.debug(`🔧:: Adjusted Transaction Compute Units: ${txSimComputeUnitsResult.computeUnits}`);
            }
        }

        // # Return Processed Transaction
        if (baseTransactionHasChanged) {
            txToReturn = await transactionBuilder(finalTxProps);
        }

        return txToReturn;
    }
}