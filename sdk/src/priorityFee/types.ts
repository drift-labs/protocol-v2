import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { HeliusPriorityFeeResponse } from './heliusPriorityFeeMethod';

export interface PriorityFeeStrategy {
	// calculate the priority fee for a given set of samples.
	// expect samples to be sorted in descending order (by slot)
	calculate(
		samples: SolanaPriorityFeeResponse[] | HeliusPriorityFeeResponse
	): number;
}

export enum PriorityFeeMethod {
	SOLANA = 'solana',
	HELIUS = 'helius',
}

export type PriorityFeeSubscriberConfig = {
	/// rpc connection, optional if using priorityFeeMethod.HELIUS
	connection?: Connection;
	/// frequency to make RPC calls to update priority fee samples, in milliseconds
	frequencyMs: number;
	/// addresses you plan to write lock, used to determine priority fees
	addresses: PublicKey[];
	/// custom strategy to calculate priority fees, defaults to AVERAGE
	customStrategy?: PriorityFeeStrategy;
	/// method for fetching priority fee samples
	priorityFeeMethod?: PriorityFeeMethod;
	/// lookback window to determine priority fees, in slots.
	slotsToCheck?: number;
	/// url for helius rpc, required if using priorityFeeMethod.HELIUS
	heliusRpcUrl?: string;
	/// clamp any returned priority fee value to this value.
	maxFeeMicroLamports?: number;
};
