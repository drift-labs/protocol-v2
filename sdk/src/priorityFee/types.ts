export interface PriorityFeeStrategy {
	// calculate the priority fee for a given set of samples.
	// expect samples to be sorted in descending order (by slot)
	calculate(samples: { slot: number; prioritizationFee: number }[]): number;
}
