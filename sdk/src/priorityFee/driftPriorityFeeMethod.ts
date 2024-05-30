import fetch from 'node-fetch';
import { HeliusPriorityLevel } from './heliusPriorityFeeMethod';

export type DriftMarketInfo = {
	marketType: string;
	marketIndex: number;
};

export type DriftPriorityFeeLevels = {
	[key in HeliusPriorityLevel]: number;
} & {
	marketType: 'perp' | 'spot';
	marketIndex: number;
};

export type DriftPriorityFeeResponse = DriftPriorityFeeLevels[];

export async function fetchDriftPriorityFee(
	url: string,
	marketTypes: string[],
	marketIndexes: number[]
): Promise<DriftPriorityFeeResponse> {
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
