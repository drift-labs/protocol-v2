import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { PriorityFeeStrategy } from './types';

export class MaxOverSlotsStrategy implements PriorityFeeStrategy {
	calculate(samples: SolanaPriorityFeeResponse[]): number {
		if (samples.length === 0) {
			return 0;
		}
		// Assuming samples are sorted in descending order of slot.
		let currMaxFee = samples[0].prioritizationFee;

		for (let i = 0; i < samples.length; i++) {
			currMaxFee = Math.max(samples[i].prioritizationFee, currMaxFee);
		}
		return currMaxFee;
	}
}
