import { PriorityFeeStrategy } from './types';

/** `PriorityFeeStrategy` that takes the max `prioritizationFee` across all samples. Unlike `MaxOverSlotsStrategy`, does not guard the empty-sample case — calling with an empty array returns `-Infinity`. */
export class MaxStrategy implements PriorityFeeStrategy {
	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		return Math.max(...samples.map((result) => result.prioritizationFee));
	}
}
