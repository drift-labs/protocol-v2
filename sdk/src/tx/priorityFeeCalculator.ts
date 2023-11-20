import { ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';

/**
 * This class determines whether a priority fee needs to be included in a transaction based on
 * a recent history of timed out transactions.
 */
export class PriorityFeeCalculator {
	lastTxTimeoutCount: number;
	priorityFeeTriggered: boolean;
	lastTxTimeoutCountTriggered: number;
	priorityFeeLatchDurationMs: number; // how long to stay in triggered state before resetting

	/**
	 * Constructor for the PriorityFeeCalculator class.
	 * @param currentTimeMs - The current time in milliseconds.
	 * @param priorityFeeLatchDurationMs - The duration for how long to stay in triggered state before resetting. Default value is 10 seconds.
	 */
	constructor(
		currentTimeMs: number,
		priorityFeeLatchDurationMs: number = 10 * 1000
	) {
		this.lastTxTimeoutCount = 0;
		this.priorityFeeTriggered = false;
		this.lastTxTimeoutCountTriggered = currentTimeMs;
		this.priorityFeeLatchDurationMs = priorityFeeLatchDurationMs;
	}

	/**
	 * Update the priority fee state based on the current time and the current timeout count.
	 * @param currentTimeMs current time in milliseconds
	 * @returns true if priority fee should be included in the next transaction
	 */
	public updatePriorityFee(
		currentTimeMs: number,
		txTimeoutCount: number
	): boolean {
		let triggerPriorityFee = false;

		if (txTimeoutCount > this.lastTxTimeoutCount) {
			this.lastTxTimeoutCount = txTimeoutCount;
			this.lastTxTimeoutCountTriggered = currentTimeMs;
			triggerPriorityFee = true;
		} else {
			if (!this.priorityFeeTriggered) {
				triggerPriorityFee = false;
			} else if (
				currentTimeMs - this.lastTxTimeoutCountTriggered <
				this.priorityFeeLatchDurationMs
			) {
				triggerPriorityFee = true;
			}
		}

		this.priorityFeeTriggered = triggerPriorityFee;

		return triggerPriorityFee;
	}

	/**
	 * This method returns a transaction instruction list that sets the compute limit on the ComputeBudget program.
	 * @param computeUnitLimit - The maximum number of compute units that can be used by the transaction.
	 * @returns An array of transaction instructions.
	 */
	public generateComputeBudgetIxs(
		computeUnitLimit: number
	): Array<TransactionInstruction> {
		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: computeUnitLimit,
			}),
		];

		return ixs;
	}

	/**
	 * Calculates the compute unit price to use based on the desired additional fee to pay and the compute unit limit.
	 * @param computeUnitLimit desired CU to use
	 * @param additionalFeeMicroLamports desired additional fee to pay, in micro lamports
	 * @returns the compute unit price to use, in micro lamports
	 */
	public calculateComputeUnitPrice(
		computeUnitLimit: number,
		additionalFeeMicroLamports: number
	): number {
		return additionalFeeMicroLamports / computeUnitLimit;
	}

	/**
	 * This method generates a list of transaction instructions for the ComputeBudget program, and includes a priority fee if it's required
	 * @param computeUnitLimit - The maximum number of compute units that can be used by the transaction.
	 * @param usePriorityFee - A boolean indicating whether to include a priority fee in the transaction, this should be from `this.updatePriorityFee()` or `this.priorityFeeTriggered`.
	 * @param additionalFeeMicroLamports - The additional fee to be paid, in micro lamports, the actual price will be calculated.
	 * @returns An array of transaction instructions.
	 */
	public generateComputeBudgetWithPriorityFeeIx(
		computeUnitLimit: number,
		usePriorityFee: boolean,
		additionalFeeMicroLamports: number
	): Array<TransactionInstruction> {
		const ixs = this.generateComputeBudgetIxs(computeUnitLimit);

		if (usePriorityFee) {
			const computeUnitPrice = this.calculateComputeUnitPrice(
				computeUnitLimit,
				additionalFeeMicroLamports
			);
			ixs.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: computeUnitPrice,
				})
			);
		}

		return ixs;
	}
}
