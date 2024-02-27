import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { PriorityFeeStrategy } from './types';

export class AverageOverSlotsStrategy implements PriorityFeeStrategy {
	calculate(samples: SolanaPriorityFeeResponse[]): number {
		if (samples.length === 0) {
			return 0;
		}
		let runningSumFees = 0;

		for (let i = 0; i < samples.length; i++) {
			runningSumFees += samples[i].prioritizationFee;
		}
		return runningSumFees / samples.length;
	}
}
