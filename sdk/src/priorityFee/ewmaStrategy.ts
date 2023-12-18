import { PriorityFeeStrategy } from './types';

class EwmaStrategy implements PriorityFeeStrategy {
	private halfLife: number;

	/**
	 * @param halfLife The half life of the EWMA in slots. Default is 25 slots, approx 10 seconds.
	 */
	constructor(halfLife = 25) {
		this.halfLife = halfLife;
	}

	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		let ewma = 0;
		let weight = 1;

		// Assuming samples are sorted in ascending order of slot.
		// getRecentPrioritizationFees returns samples in ascending order of slot.
		for (let i = samples.length - 1; i > 0; i--) {
			const gap = samples[i].slot - samples[i - 1].slot;
			const lambda = Math.pow(0.5, gap / this.halfLife);
			ewma += weight * samples[i].prioritizationFee;
			weight *= lambda;
		}

		// Handle the first sample separately
		if (samples.length > 0) {
			ewma += weight * samples[0].prioritizationFee;
		}

		return ewma;
	}
}

export { EwmaStrategy };
