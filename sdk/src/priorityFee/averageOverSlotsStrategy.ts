import { PriorityFeeStrategy } from './types';

export class AverageOverSlotsStrategy implements PriorityFeeStrategy {
	private lookbackSlots: number;

	/**
	 * @param lookbackSlots The number of slots to look back from the max slot in the sample
	 */
	constructor(lookbackSlots = 10) {
		this.lookbackSlots = lookbackSlots;
	}

	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		if (samples.length === 0) {
			return 0;
		}
		const stopSlot = samples[0].slot - this.lookbackSlots;
		let runningSumFees = 0;
		let countFees = 0;

		for (let i = 0; i < samples.length; i++) {
			if (samples[i].slot <= stopSlot) {
				return runningSumFees / countFees;
			}
			runningSumFees += samples[i].prioritizationFee;
			countFees++;
		}
		return runningSumFees / countFees;
	}
}
