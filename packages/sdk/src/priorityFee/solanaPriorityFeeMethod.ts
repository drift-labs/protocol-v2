import { Connection } from '@solana/web3.js';

/** One sample from Solana's `getRecentPrioritizationFees`. */
export type SolanaPriorityFeeResponse = {
	slot: number;
	/** Priority fee paid, in micro-lamports per compute unit. */
	prioritizationFee: number;
};

/**
 * Fetches recent prioritization fees for `addresses` via the Solana RPC
 * `getRecentPrioritizationFees` method, then filters to the most recent
 * `lookbackDistance` slots (relative to the newest returned slot, not the
 * current chain tip) and sorts descending by slot.
 * @param connection RPC connection.
 * @param lookbackDistance Number of slots back from the newest sample to retain.
 * @param addresses Account keys to scope the fee lookup to (accounts the transaction will write-lock).
 * @returns Filtered, slot-descending samples; `undefined` if the RPC returned zero results; an empty array if the RPC call itself threw (error is logged, not thrown).
 */
export async function fetchSolanaPriorityFee(
	connection: Connection,
	lookbackDistance: number,
	addresses: string[]
): Promise<SolanaPriorityFeeResponse[] | undefined> {
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
