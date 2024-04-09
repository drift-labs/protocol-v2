import fetch from 'node-fetch';
import { HeliusPriorityFeeLevels } from './heliusPriorityFeeMethod';

export type DriftPriorityFeeResponse = HeliusPriorityFeeLevels[];

export async function fetchDriftPriorityFee(
	url: string,
	marketType: string,
	marketIndex: number
): Promise<DriftPriorityFeeResponse> {
	const response = await fetch(
		`${url}?marketType=${marketType}&marketIndex=${marketIndex}`
	);
	return await response.json();
}
