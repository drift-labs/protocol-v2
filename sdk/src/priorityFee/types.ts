export interface PriorityFeeStrategy {
	// calculate the priority fee for a given set of samples from the
	// getRecentPrioritizationFees RPC method
	calculate(samples: { slot: number; prioritizationFee: number }[]): number;
}
