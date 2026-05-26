import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { HeliusPriorityFeeResponse } from './heliusPriorityFeeMethod';
import {
	VelocityMarketInfo,
	VelocityPriorityFeeResponse,
} from './velocityPriorityFeeMethod';
import { AtLeastOne } from '../util/deprecatedAlias';

export const DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS = 10_000;

export interface PriorityFeeStrategy {
	// calculate the priority fee for a given set of samples.
	// expect samples to be sorted in descending order (by slot)
	calculate(
		samples:
			| SolanaPriorityFeeResponse[]
			| HeliusPriorityFeeResponse
			| VelocityPriorityFeeResponse
	): number;
}

export enum PriorityFeeMethod {
	SOLANA = 'solana',
	HELIUS = 'helius',
	VELOCITY = 'velocity',
}

export type PriorityFeeSubscriberConfig = {
	/// rpc connection, optional if using priorityFeeMethod.HELIUS
	connection?: Connection;
	/// frequency to make RPC calls to update priority fee samples, in milliseconds
	frequencyMs?: number;
	/// addresses you plan to write lock, used to determine priority fees
	addresses?: PublicKey[];
	/// market type and index, optionally provide at initialization time if using priorityFeeMethod.VELOCITY
	velocityMarkets?: VelocityMarketInfo[];
	/** @deprecated Use `velocityMarkets` instead. `driftMarkets` will be removed in a future major. */
	driftMarkets?: VelocityMarketInfo[];
	/// custom strategy to calculate priority fees, defaults to AVERAGE
	customStrategy?: PriorityFeeStrategy;
	/// method for fetching priority fee samples
	priorityFeeMethod?: PriorityFeeMethod;
	/// lookback window to determine priority fees, in slots.
	slotsToCheck?: number;
	/// url for helius rpc, required if using priorityFeeMethod.HELIUS
	heliusRpcUrl?: string;
	/// url for Velocity cached priority fee endpoint, required if using priorityFeeMethod.VELOCITY
	velocityPriorityFeeEndpoint?: string;
	/** @deprecated Use `velocityPriorityFeeEndpoint` instead. `driftPriorityFeeEndpoint` will be removed in a future major. */
	driftPriorityFeeEndpoint?: string;
	/// clamp any returned priority fee value to this value.
	maxFeeMicroLamports?: number;
	/// multiplier applied to priority fee before maxFeeMicroLamports, defaults to 1.0
	priorityFeeMultiplier?: number;
};

type PriorityFeeSubscriberMapConfigBase = {
	/// frequency to make RPC calls to update priority fee samples, in milliseconds
	frequencyMs?: number;
	/// market type and associated market index to query
	velocityMarkets?: VelocityMarketInfo[];
	/** @deprecated Use `velocityMarkets` instead. `driftMarkets` will be removed in a future major. */
	driftMarkets?: VelocityMarketInfo[];
};

/// url for Velocity cached priority fee endpoint
export type PriorityFeeSubscriberMapConfig =
	PriorityFeeSubscriberMapConfigBase &
		AtLeastOne<
			'velocityPriorityFeeEndpoint',
			'driftPriorityFeeEndpoint',
			string
		>;
