import { PriorityFeeStrategy } from './types';

export class MaxStrategy implements PriorityFeeStrategy {
	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		return Math.max(...samples.map((result) => result.prioritizationFee));
	}
}
