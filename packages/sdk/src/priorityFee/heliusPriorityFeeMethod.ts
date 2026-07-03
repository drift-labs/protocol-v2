import fetch from 'node-fetch';

/** Percentile buckets returned by Helius's `getPriorityFeeEstimate` (`includeAllPriorityFeeLevels`). */
export enum HeliusPriorityLevel {
	MIN = 'min', // 25th percentile
	LOW = 'low', // 25th percentile
	MEDIUM = 'medium', // 50th percentile
	HIGH = 'high', // 75th percentile
	VERY_HIGH = 'veryHigh', // 95th percentile
	UNSAFE_MAX = 'unsafeMax', // 100th percentile
}

/** Priority fee (micro-lamports/CU) at each `HeliusPriorityLevel` percentile. */
export type HeliusPriorityFeeLevels = {
	[key in HeliusPriorityLevel]: number;
};

/** Raw JSON-RPC response from Helius's `getPriorityFeeEstimate`. */
export type HeliusPriorityFeeResponse = {
	jsonrpc: string;
	result: {
		/** Single-value estimate; only populated when `includeAllPriorityFeeLevels` was not requested. */
		priorityFeeEstimate?: number;
		/** Per-percentile estimates; populated when `includeAllPriorityFeeLevels: true` is requested (as `fetchHeliusPriorityFee` does). */
		priorityFeeLevels?: HeliusPriorityFeeLevels;
	};
	id: string;
};

/**
 * Fetches priority fee estimates from the Helius `getPriorityFeeEstimate` API
 * (https://docs.helius.dev/solana-rpc-nodes/alpha-priority-fee-api).
 * @param heliusRpcUrl Helius RPC URL to POST the `getPriorityFeeEstimate` request to.
 * @param lookbackDistance Number of recent slots to consider (`lookbackSlots` option).
 * @param addresses Account keys to scope the estimate to (accounts the transaction will write-lock).
 * @returns The full Helius response (with `includeAllPriorityFeeLevels: true`), or `undefined` if the request failed (error is logged, not thrown).
 */
export async function fetchHeliusPriorityFee(
	heliusRpcUrl: string,
	lookbackDistance: number,
	addresses: string[]
): Promise<HeliusPriorityFeeResponse | undefined> {
	try {
		const response = await fetch(heliusRpcUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: '1',
				method: 'getPriorityFeeEstimate',
				params: [
					{
						accountKeys: addresses,
						options: {
							includeAllPriorityFeeLevels: true,
							lookbackSlots: lookbackDistance,
						},
					},
				],
			}),
		});
		return await response.json();
	} catch (err) {
		console.error(err);
	}

	return undefined;
}
