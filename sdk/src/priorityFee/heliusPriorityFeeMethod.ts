import fetch from 'node-fetch';

export enum HeliusPriorityLevel {
	MIN = 'min', // 25th percentile
	LOW = 'low', // 25th percentile
	MEDIUM = 'medium', // 50th percentile
	HIGH = 'high', // 75th percentile
	VERY_HIGH = 'veryHigh', // 95th percentile
	UNSAFE_MAX = 'unsafeMax', // 100th percentile
}

export type HeliusPriorityFeeLevels = {
	[key in HeliusPriorityLevel]: number;
};

export type HeliusPriorityFeeResponse = {
	jsonrpc: string;
	result: {
		priorityFeeEstimate?: number;
		priorityFeeLevels?: HeliusPriorityFeeLevels;
	};
	id: string;
};

/// Fetches the priority fee from the Helius API
/// https://docs.helius.dev/solana-rpc-nodes/alpha-priority-fee-api
export async function fetchHeliusPriorityFee(
	heliusRpcUrl: string,
	lookbackDistance: number,
	addresses: string[]
): Promise<HeliusPriorityFeeResponse> {
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
