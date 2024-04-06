import { AddressLookupTableAccount, Connection, RpcResponseAndContext, SimulatedTransactionResponse, Transaction, TransactionInstruction, TransactionVersion, VersionedTransaction } from "@solana/web3.js";
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
			return txSim?.value?.unitsConsumed * 1.2;
		} 

		return undefined;
	}

	private static async getTxSimComputeUnits(
		tx : VersionedTransaction,
        connection: Connection
	) {
		try {

            if (TEST_SIMS_ALWAYS_FAIL) throw new Error('Test Error::SIMS_ALWAYS_FAIL');

			const simTxResult = (await connection.simulateTransaction(
				tx,
				{
					replaceRecentBlockhash: true,
					commitment: 'confirmed',
				}
			));

			return this.getComputeUnitsFromSim(
				simTxResult
			);
		} catch (e) {
			return undefined;
		}
	}

    static async process(
        props : {
            txProps: TransactionProps,
            txBuilder: (baseTransactionProps: TransactionProps) => Promise<Transaction|VersionedTransaction>,
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
            const txSimComputeUnits = await this.getTxSimComputeUnits(
                baseTransaction as VersionedTransaction,
                processProps.connection
            );

            if (txSimComputeUnits && txSimComputeUnits!==transactionProps?.txParams?.computeUnits) {
                // Adjust the transaction based on the simulated compute units
                finalTxProps.txParams = {
                    ...transactionProps.txParams,
                    computeUnits: txSimComputeUnits * COMPUTE_UNIT_BUFFER_FACTOR
                };
                baseTransactionHasChanged = true;

                console.log(`🔧:: Adjusted Transaction Compute Units: ${txSimComputeUnits}`);
            }
        }

        // # Return Processed Transaction
        if (baseTransactionHasChanged) {
            txToReturn = await transactionBuilder(finalTxProps);
        }

        return txToReturn;
    }
}