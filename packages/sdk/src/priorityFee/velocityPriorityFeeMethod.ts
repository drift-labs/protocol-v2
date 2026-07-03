import fetch from 'node-fetch';
import { HeliusPriorityLevel } from './heliusPriorityFeeMethod';

/** Identifies a market to fetch/track priority fees for. */
export type VelocityMarketInfo = {
	marketType: string;
	marketIndex: number;
};

/** Per-percentile priority fee (micro-lamports/CU, same buckets as `HeliusPriorityLevel`) for one market, as returned by the Velocity priority fee endpoint. */
export type VelocityPriorityFeeLevels = {
	[key in HeliusPriorityLevel]: number;
} & {
	marketType: 'perp' | 'spot';
	marketIndex: number;
};

/** One `VelocityPriorityFeeLevels` entry per requested market. */
export type VelocityPriorityFeeResponse = VelocityPriorityFeeLevels[];

/**
 * Fetches per-market priority fee levels from the Velocity-hosted
 * `/batchPriorityFees` endpoint.
 * @param url Base URL of the Velocity priority fee service.
 * @param marketTypes Market types to query, parallel-indexed to `marketIndexes` (e.g. `['perp', 'perp', 'spot']`).
 * @param marketIndexes Market indexes to query, parallel-indexed to `marketTypes`.
 * @returns One `VelocityPriorityFeeLevels` per requested market; an empty array if the request failed (error is logged, not thrown) or returned a non-OK HTTP status.
 */
export async function fetchVelocityPriorityFee(
	url: string,
	marketTypes: string[],
	marketIndexes: number[]
): Promise<VelocityPriorityFeeResponse> {
	try {
		const response = await fetch(
			`${url}/batchPriorityFees?marketType=${marketTypes.join(
				','
			)}&marketIndex=${marketIndexes.join(',')}`
		);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		return await response.json();
	} catch (err) {
		if (err instanceof Error) {
			console.error('Error fetching priority fees:', err.message);
		} else {
			console.error('Unknown error fetching priority fees:', err);
		}
	}

	return [];
}
