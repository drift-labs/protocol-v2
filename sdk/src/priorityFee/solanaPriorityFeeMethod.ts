import { Connection } from '@solana/web3.js';

export type SolanaPriorityFeeResponse = {
	slot: number;
	prioritizationFee: number;
};

export async function fetchSolanaPriorityFee(
	connection: Connection,
	lookbackDistance: number,
	addresses: string[]
): Promise<SolanaPriorityFeeResponse[]> {
	try {
		// @ts-ignore
		const rpcJSONResponse: any = await connection._rpcRequest(
			'getRecentPrioritizationFees',
			[addresses]
		);

		const results: SolanaPriorityFeeResponse[] = rpcJSONResponse?.result;

		if (!results.length) return;

		// Sort and filter results based on the slot lookback setting
		const descResults = results.sort((a, b) => b.slot - a.slot);
		const cutoffSlot = descResults[0].slot - lookbackDistance;

		return descResults.filter((result) => result.slot >= cutoffSlot);
	} catch (err) {
		console.error(err);
	}

	return [];
}
