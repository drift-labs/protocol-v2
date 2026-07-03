import {
	Connection,
	RpcResponseAndContext,
	SimulatedTransactionResponse,
	VersionedTransaction,
} from '@solana/web3.js';
import { BaseTxParams, ProcessingTxParams } from '../types';

const COMPUTE_UNIT_BUFFER_FACTOR = 1.2;
const MAX_COMPUTE_UNITS = 1_400_000;

const TEST_SIMS_ALWAYS_FAIL = false;

type TransactionBuildingProps = {
	txParams: BaseTxParams;
};

/**
 * This class is responsible for running through a "processing" pipeline for a base transaction, to adjust the standard transaction parameters based on a given configuration.
 *
 * Currently the only pipeline step is simulation-based compute unit resolution: build the
 * transaction with a max compute-unit budget, simulate it, and replace the compute-unit limit
 * (and optionally the compute-unit price) with values derived from actual simulated usage.
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

	/**
	 * Determines a compute-unit limit to use for a transaction by simulating it (or reusing a
	 * pre-supplied simulation), applying `bufferMultiplier` to the actually-consumed units, and
	 * clamping the result to at most `MAX_COMPUTE_UNITS` (1,400,000). Simulation runs with
	 * `replaceRecentBlockhash: true` to avoid spurious `blockHashNotFound` failures from an
	 * already-stale blockhash on the transaction being sized. Never throws: any error (including
	 * a simulation error result) is caught and reported via the `success: false` return.
	 * @param tx - Transaction to simulate (ignored if `simulatedTx` is supplied instead).
	 * @param connection - RPC connection used to simulate, if `simulatedTx` isn't provided.
	 * @param bufferMultiplier - Multiplier applied to the raw consumed compute units before
	 * clamping (e.g. `1.2` for a 20% buffer) — mandatory to force callers to account for
	 * simulated CU counts being an imperfect predictor of the real on-chain cost.
	 * @param lowerBoundCu - If provided, the result is floored at `min(lowerBoundCu, MAX_COMPUTE_UNITS)`.
	 * @param simulatedTx - A pre-computed simulation result to reuse instead of simulating `tx` again.
	 * @returns `{ success: true, computeUnits }` with the buffered/clamped compute-unit limit on
	 * success, or `{ success: false, computeUnits: undefined }` if simulation failed or returned no
	 * `unitsConsumed`.
	 */
	public static async getTxSimComputeUnits(
		tx: VersionedTransaction,
		connection: Connection,
		bufferMultiplier: number, // Making this a mandatory param to force the user to remember that simulated CU's can be inaccurate and a buffer should be applied
		lowerBoundCu?: number,
		simulatedTx?: SimulatedTransactionResponse
	): Promise<
		| { success: true; computeUnits: number }
		| { success: false; computeUnits: undefined }
	> {
		try {
			if (TEST_SIMS_ALWAYS_FAIL)
				throw new Error('Test Error::SIMS_ALWAYS_FAIL');

			const simTxResult = simulatedTx
				? ({
						value: simulatedTx,
				  } as RpcResponseAndContext<SimulatedTransactionResponse>)
				: await connection.simulateTransaction(tx, {
						replaceRecentBlockhash: true, // This is important to ensure that the blockhash is not too new.. Otherwise we will very often receive a "blockHashNotFound" error
				  });

			if (simTxResult?.value?.err) {
				throw simTxResult?.value?.err;
			}

			const computeUnits = await this.getComputeUnitsFromSim(simTxResult);

			if (computeUnits === undefined) {
				throw new Error(
					'TransactionParamProcessor: simulation did not return units consumed'
				);
			}

			// Apply the buffer, but round down to the MAX_COMPUTE_UNITS, and round up to the nearest whole number
			let bufferedComputeUnits = Math.ceil(
				Math.min(computeUnits * bufferMultiplier, MAX_COMPUTE_UNITS)
			);

			// If a lower bound CU is passed then enforce it
			if (lowerBoundCu) {
				bufferedComputeUnits = Math.max(
					bufferedComputeUnits,
					Math.min(lowerBoundCu, MAX_COMPUTE_UNITS)
				);
			}

			return {
				success: true as const,
				computeUnits: bufferedComputeUnits,
			};
		} catch (e) {
			console.warn(
				`Failed to get Simulated Compute Units for txParamProcessor`,
				e
			);

			return {
				success: false as const,
				computeUnits: undefined,
			};
		}
	}

	/**
	 * Runs the configured processing steps against a base set of tx params and returns the
	 * adjusted params. If `processConfig` is empty/absent, returns `baseTxParams` unchanged
	 * without building or simulating anything.
	 *
	 * When `processConfig.useSimulatedComputeUnits` is set: rebuilds the transaction (via
	 * `txBuilder`) with `computeUnits` forced to `MAX_COMPUTE_UNITS` so simulation isn't
	 * constrained by an under-sized limit, simulates it, and — on success — replaces
	 * `computeUnits` with the result of `getTxSimComputeUnits` (failure leaves the original
	 * `baseTxParams.computeUnits` untouched, it does not throw).
	 *
	 * When additionally `processConfig.useSimulatedComputeUnitsForCUPriceCalculation` is set:
	 * derives `computeUnitsPrice` from the simulated `computeUnits` via
	 * `processConfig.getCUPriceFromComputeUnits`.
	 * @param props.baseTxParams - Starting compute-unit limit/price to adjust.
	 * @param props.processConfig - Which processing steps to run (see `ProcessingTxParams`).
	 * @param props.processParams.connection - RPC connection used for simulation.
	 * @param props.processParams.simulatedTx - Pre-computed simulation result to reuse instead of simulating again.
	 * @param props.txBuilder - Builds a `VersionedTransaction` from a given `BaseTxParams`, used to
	 * produce the transaction that gets simulated.
	 * @returns The adjusted `BaseTxParams`.
	 * @throws Error if `useSimulatedComputeUnitsForCUPriceCalculation` is set without
	 * `useSimulatedComputeUnits`, without `getCUPriceFromComputeUnits`, or if the simulated compute
	 * units are unavailable (simulation failed).
	 */
	static async process(props: {
		baseTxParams: BaseTxParams;
		processConfig: ProcessingTxParams;
		processParams: {
			connection: Connection;
			simulatedTx?: SimulatedTransactionResponse;
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

		const finalTxParams: BaseTxParams = {
			...props.baseTxParams,
		};

		// # Run Processes
		if (processConfig.useSimulatedComputeUnits) {
			const txToSim = await txBuilder({
				txParams: { ...finalTxParams, computeUnits: MAX_COMPUTE_UNITS },
			});

			const txSimComputeUnitsResult = await this.getTxSimComputeUnits(
				txToSim,
				processProps.connection,
				processConfig?.computeUnitsBufferMultiplier ??
					COMPUTE_UNIT_BUFFER_FACTOR,
				undefined,
				processProps.simulatedTx
			);

			if (txSimComputeUnitsResult.success) {
				// Adjust the transaction based on the simulated compute units
				finalTxParams.computeUnits = txSimComputeUnitsResult.computeUnits;
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

			if (simulatedComputeUnits === undefined) {
				throw new Error(
					`encountered useSimulatedComputeUnitsForFees=true, but simulated compute units are unavailable (simulation likely failed)`
				);
			}

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
