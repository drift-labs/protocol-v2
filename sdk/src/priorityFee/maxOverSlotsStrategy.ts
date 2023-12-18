import { PriorityFeeStrategy } from './types';

export class MaxOverSlotsStrategy implements PriorityFeeStrategy {
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
		// Assuming samples are sorted in descending order of slot.
		const stopSlot = samples[0].slot - this.lookbackSlots;
		let currMaxFee = samples[0].prioritizationFee;

		for (let i = 0; i < samples.length; i++) {
			if (samples[i].slot <= stopSlot) {
				return currMaxFee;
			}
			if (samples[i].prioritizationFee > currMaxFee) {
				currMaxFee = samples[i].prioritizationFee;
			}
		}
		return currMaxFee;
	}
}
