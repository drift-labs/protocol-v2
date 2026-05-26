import fetch from 'node-fetch';
import { HeliusPriorityLevel } from './heliusPriorityFeeMethod';

export type VelocityMarketInfo = {
	marketType: string;
	marketIndex: number;
};

/** @deprecated Use `VelocityMarketInfo` instead. `DriftMarketInfo` will be removed in a future major. */
export type DriftMarketInfo = VelocityMarketInfo;

export type VelocityPriorityFeeLevels = {
	[key in HeliusPriorityLevel]: number;
} & {
	marketType: 'perp' | 'spot';
	marketIndex: number;
};

/** @deprecated Use `VelocityPriorityFeeLevels` instead. `DriftPriorityFeeLevels` will be removed in a future major. */
export type DriftPriorityFeeLevels = VelocityPriorityFeeLevels;

export type VelocityPriorityFeeResponse = VelocityPriorityFeeLevels[];

/** @deprecated Use `VelocityPriorityFeeResponse` instead. `DriftPriorityFeeResponse` will be removed in a future major. */
export type DriftPriorityFeeResponse = VelocityPriorityFeeResponse;

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

/** @deprecated Use `fetchVelocityPriorityFee` instead. `fetchDriftPriorityFee` will be removed in a future major. */
export const fetchDriftPriorityFee = fetchVelocityPriorityFee;
