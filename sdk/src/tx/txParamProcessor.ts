import {
	Connection,
	RpcResponseAndContext,
	SimulatedTransactionResponse,
	VersionedTransaction
} from '@solana/web3.js';
import { BaseTxParams, ProcessingTxParams } from '..';

const COMPUTE_UNIT_BUFFER_FACTOR = 1.2;

const TEST_SIMS_ALWAYS_FAIL = false;

type TransactionBuildingProps = {
	txParams: BaseTxParams;
};

/**
 * This class is responsible for running through a "processing" pipeline for a base transaction, to adjust the standard transaction parameters based on a given configuration.
 */
export class TransactionParamProcessor {
	private static async getComputeUnitsFromSim(
		txSim: RpcResponseAndContext<SimulatedTransactionResponse>
	) {
		if (txSim?.value?.unitsConsumed) {
			return txSim?.value?.unitsConsumed;
		}

		return undefined;
	}

	public static async getTxSimComputeUnits(
		tx: VersionedTransaction,
		connection: Connection
	): Promise<{ success: boolean; computeUnits: number }> {
		try {
			if (TEST_SIMS_ALWAYS_FAIL)
				throw new Error('Test Error::SIMS_ALWAYS_FAIL');

			const simTxResult = await connection.simulateTransaction(tx, {
				replaceRecentBlockhash: true, // This is important to ensure that the blockhash is not too new.. Otherwise we will very often receive a "blockHashNotFound" error
			});

			if (simTxResult?.value?.err) {
				throw new Error(simTxResult?.value?.err?.toString());
			}

			const computeUnits = await this.getComputeUnitsFromSim(simTxResult);

			return {
				success: true,
				computeUnits: computeUnits,
			};
		} catch (e) {
			console.warn(
				`Failed to get Simulated Compute Units for txParamProcessor`,
				e
			);

			return {
				success: false,
				computeUnits: undefined,
			};
		}
	}

	static async process(props: {
		baseTxParams: BaseTxParams;
		processConfig: ProcessingTxParams;
		processParams: {
			connection: Connection;
		};
		txBuilder: (
			baseTransactionProps: TransactionBuildingProps
		) => Promise<VersionedTransaction>;
	}): Promise<BaseTxParams> {
		// # Exit early if no process config is provided
		if (!props.processConfig || Object.keys(props.processConfig).length === 0) {
			return props.baseTxParams;
		}

		// # Setup
		const {
			txBuilder: txBuilder,
			processConfig,
			processParams: processProps,
		} = props;

		const finalTxParams : BaseTxParams = {
			...props.baseTxParams,
		};

		// # Run Processes
		if (processConfig.useSimulatedComputeUnits) {
			const txToSim = await txBuilder({
				txParams: { ...finalTxParams, computeUnits: 1_400_000 },
			});

			const txSimComputeUnitsResult = await this.getTxSimComputeUnits(
				txToSim,
				processProps.connection
			);

			if (txSimComputeUnitsResult.success) {
				const bufferedComputeUnits =
					txSimComputeUnitsResult.computeUnits *
					(processConfig?.computeUnitsBufferMultiplier ??
						COMPUTE_UNIT_BUFFER_FACTOR);

				// Adjust the transaction based on the simulated compute units
				finalTxParams.computeUnits = Math.ceil(bufferedComputeUnits); // Round the compute units to a whole number
			}
		}

		if (processConfig?.useSimulatedComputeUnitsForCUPriceCalculation) {
			if (!processConfig?.useSimulatedComputeUnits) {
				throw new Error(
					`encountered useSimulatedComputeUnitsForFees=true, but useSimulatedComputeUnits is false`
				);
			}
			if (!processConfig?.getCUPriceFromComputeUnits) {
				throw new Error(
					`encountered useSimulatedComputeUnitsForFees=true, but getComputeUnitPriceFromUnitsToUse helper method is undefined`
				);
			}

			const simulatedComputeUnits = finalTxParams.computeUnits;

			const computeUnitPrice = processConfig.getCUPriceFromComputeUnits(
				simulatedComputeUnits
			);

			console.debug(
				`🔧:: Adjusting compute unit price for simulated compute unit budget :: ${finalTxParams.computeUnitsPrice}=>${computeUnitPrice}`
			);

			finalTxParams.computeUnitsPrice = computeUnitPrice;
		}

		// # Return Final Tx Params
		return finalTxParams;
	}
}
