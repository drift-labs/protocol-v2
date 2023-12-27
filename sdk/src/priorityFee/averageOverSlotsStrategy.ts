import { PriorityFeeStrategy } from './types';
import { assertSamplesDescending } from './utils';

export class AverageOverSlotsStrategy implements PriorityFeeStrategy {

	constructor() {}

	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		assertSamplesDescending(samples);
		if (samples.length === 0) {
			return 0;
		}
		let runningSumFees = 0;
		let countFees = 0;

		for (let i = 0; i < samples.length; i++) {
			runningSumFees += samples[i].prioritizationFee;
			countFees++;
		}
		return runningSumFees / countFees;
	}
}
