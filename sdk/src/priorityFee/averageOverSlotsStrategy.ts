import { PriorityFeeStrategy } from './types';

export class AverageOverSlotsStrategy implements PriorityFeeStrategy {
	private lookbackSlots: number;

	/**
	 * @param lookbackSlots The number of slots to look back from the max slot in the sample
	 */
	constructor(lookbackSlots = 25) {
		this.lookbackSlots = lookbackSlots;
	}

	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		if (samples.length === 0) {
			return 0;
		}
		const stopSlot = samples[samples.length - 1].slot - this.lookbackSlots + 1;
		let runningSumFees = 0;
		let countFees = 0;

		// samples from getRecentPrioritizationFees are sorted in ascending order of slot
		// so we can iterate backwards.
		for (let i = samples.length - 1; i >= 0; i--) {
			if (samples[i].slot < stopSlot) {
				return runningSumFees / countFees;
			}
			runningSumFees += samples[i].prioritizationFee;
			countFees++;
		}
		return runningSumFees / countFees;
	}
}
