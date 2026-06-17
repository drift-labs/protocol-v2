import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { PriorityFeeStrategy } from './types';

export class AverageStrategy implements PriorityFeeStrategy {
	calculate(samples: SolanaPriorityFeeResponse[]): number {
		return (
			samples.reduce((a, b) => {
				return a + b.prioritizationFee;
			}, 0) / samples.length
		);
	}
}
