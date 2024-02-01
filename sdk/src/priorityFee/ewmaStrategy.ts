import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { PriorityFeeStrategy } from './types';

class EwmaStrategy implements PriorityFeeStrategy {
	private halfLife: number;

	/**
	 * @param halfLife The half life of the EWMA in slots. Default is 25 slots, approx 10 seconds.
	 */
	constructor(halfLife = 25) {
		this.halfLife = halfLife;
	}

	// samples provided in desc slot order
	calculate(samples: SolanaPriorityFeeResponse[]): number {
		if (samples.length === 0) {
			return 0;
		}
		if (samples.length === 1) {
			return samples[0].prioritizationFee;
		}

		let ewma = 0;

		const samplesReversed = samples.slice().reverse();
		for (let i = 0; i < samplesReversed.length; i++) {
			if (i === 0) {
				ewma = samplesReversed[i].prioritizationFee;
				continue;
			}
			const gap = samplesReversed[i].slot - samplesReversed[i - 1].slot;
			const alpha = 1 - Math.exp((Math.log(0.5) / this.halfLife) * gap);

			ewma = alpha * samplesReversed[i].prioritizationFee + (1 - alpha) * ewma;
		}

		return ewma;
	}
}

export { EwmaStrategy };
