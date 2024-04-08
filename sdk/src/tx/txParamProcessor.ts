import { AddressLookupTableAccount, Connection, RpcResponseAndContext, SimulatedTransactionResponse, TransactionInstruction, TransactionVersion, VersionedTransaction } from "@solana/web3.js";
import { BaseTxParams, ProcessingTxParams } from "..";

const COMPUTE_UNIT_BUFFER_FACTOR = 1.2;

const TEST_SIMS_ALWAYS_FAIL = false;

type TransactionProps = {
    instructions: TransactionInstruction | TransactionInstruction[],
    txParams?: BaseTxParams,
    txVersion?: TransactionVersion,
    lookupTables?: AddressLookupTableAccount[]
    forceVersionedTransaction?: boolean
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

            if (version === undefined || version==='legacy') {
                console.debug(`🔧:: Running Simulation for LEGACY TX`);
            } else {
                console.debug(`🔧:: Running Simulation for VERSIONED TX`);
            }

            const simTxResult = (await connection.simulateTransaction(
                tx,
                {
                    replaceRecentBlockhash: true, // This is important to ensure that the blockhash is not too new.. Otherwise we will very often receive a "blockHashNotFound" error
                }
            ));

            if (simTxResult?.value?.err) {
                throw new Error(simTxResult?.value?.err?.toString());
            }

			const computeUnits = await this.getComputeUnitsFromSim(
				simTxResult
			);

            return {
                success: true,
                computeUnits: computeUnits
            };
		} catch (e) {
            console.warn(`Failed to get Simulated Compute Units`, e);

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
    ) : Promise<BaseTxParams> {

        // # Exit early if no process config is provided
        if (!props.processConfig || Object.keys(props.processConfig).length===0) {
            return props.txProps.txParams;
        }

        // # Setup
        const {
            txProps: txProps,
            txBuilder: txBuilder,
            processConfig,
            processParams: processProps
        } = props;

        const baseTransaction = await txBuilder(txProps);

        const finalTxProps = {
            ...txProps
        };

        // # Run Processes
        if (processConfig.useSimulatedComputeUnits) {

            const txSimComputeUnitsResult = await this.getTxSimComputeUnits(
                baseTransaction,
                processProps.connection
            );

            if (txSimComputeUnitsResult.success && txSimComputeUnitsResult.computeUnits!==txProps?.txParams?.computeUnits) {
                // Adjust the transaction based on the simulated compute units
                finalTxProps.txParams = {
                    ...txProps.txParams,
                    computeUnits: txSimComputeUnitsResult.computeUnits
                };

                console.debug(`🔧:: Adjusted Transaction Compute Units: ${txSimComputeUnitsResult.computeUnits}`);
            }
        }

        // # Return Final Tx Params
        return finalTxProps.txParams;
    }
}