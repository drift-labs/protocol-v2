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
		return await response.json();
	} catch (err) {
		console.error(err);
	}

	return [];
}
