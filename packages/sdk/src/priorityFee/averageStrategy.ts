import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { PriorityFeeStrategy } from './types';

/** `PriorityFeeStrategy` that averages `prioritizationFee` across all samples. Unlike `AverageOverSlotsStrategy`, does not guard the empty-sample case — calling with `samples.length === 0` returns `NaN`. */
export class AverageStrategy implements PriorityFeeStrategy {
	calculate(samples: SolanaPriorityFeeResponse[]): number {
		return (
			samples.reduce((a, b) => {
				return a + b.prioritizationFee;
			}, 0) / samples.length
		);
	}
}
