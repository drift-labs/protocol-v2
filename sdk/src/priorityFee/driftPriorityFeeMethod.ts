import fetch from 'node-fetch';
import { HeliusPriorityFeeLevels } from './heliusPriorityFeeMethod';

export type DriftPriorityFeeResponse = HeliusPriorityFeeLevels[];

export async function fetchDriftPriorityFee(
	url: string,
	marketTypes: string[],
	marketIndexs: number[]
): Promise<DriftPriorityFeeResponse> {
	try {
		const response = await fetch(
			`${url}/batchPriorityFees?marketType=${marketTypes.join(
				','
			)}&marketIndex=${marketIndexs.join(',')}`
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
