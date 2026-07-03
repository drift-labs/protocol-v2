import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaPriorityFeeResponse } from './solanaPriorityFeeMethod';
import { HeliusPriorityFeeResponse } from './heliusPriorityFeeMethod';
import {
	VelocityMarketInfo,
	VelocityPriorityFeeResponse,
} from './velocityPriorityFeeMethod';

/** Default poll interval (ms) for `PriorityFeeSubscriber`/`PriorityFeeSubscriberMap` when `frequencyMs` is not configured. */
export const DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS = 10_000;

/**
 * A pluggable priority-fee aggregation function. `PriorityFeeSubscriber`
 * calls `calculate` after each poll to derive `getCustomStrategyResult()`.
 * Built-in implementations: `AverageStrategy`/`AverageOverSlotsStrategy`,
 * `EwmaStrategy`, `MaxStrategy`/`MaxOverSlotsStrategy`.
 */
export interface PriorityFeeStrategy {
	// calculate the priority fee for a given set of samples.
	// when samples is an array (SOLANA), expect it sorted in descending order (by slot)
	/**
	 * @param samples Fee samples from whichever `priorityFeeMethod` is active — `SolanaPriorityFeeResponse[]` for SOLANA (expected sorted descending by slot), a single `HeliusPriorityFeeResponse` for HELIUS, or `VelocityPriorityFeeResponse` for VELOCITY.
	 * @returns A priority fee estimate in micro-lamports per compute unit.
	 */
	calculate(
		samples:
			| SolanaPriorityFeeResponse[]
			| HeliusPriorityFeeResponse
			| VelocityPriorityFeeResponse
	): number;
}

/** Which upstream API `PriorityFeeSubscriber` queries for priority-fee samples. */
export enum PriorityFeeMethod {
	/** Solana RPC `getRecentPrioritizationFees`. Requires `connection`. */
	SOLANA = 'solana',
	/** Helius `getPriorityFeeEstimate`. Requires `heliusRpcUrl` or a Helius `connection`. */
	HELIUS = 'helius',
	/** Velocity-hosted priority fee cache, scoped by market. Requires `velocityPriorityFeeEndpoint` and `velocityMarkets`. */
	VELOCITY = 'velocity',
}

/** Configuration for `PriorityFeeSubscriber`. Which fields are required depends on `priorityFeeMethod` — see `PriorityFeeMethod`. */
export type PriorityFeeSubscriberConfig = {
	/** RPC connection used for SOLANA sampling (and as a Helius URL source for HELIUS if `heliusRpcUrl` is omitted); optional only when `priorityFeeMethod` is `HELIUS` or `VELOCITY`. */
	connection?: Connection;
	/** Poll interval in milliseconds for `load()`; defaults to `DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS` (10s). */
	frequencyMs?: number;
	/** Account keys the transaction will write-lock; scopes SOLANA/HELIUS fee sampling to congestion on these accounts specifically. */
	addresses?: PublicKey[];
	/** Markets to query when `priorityFeeMethod` is `VELOCITY`; can also be supplied later via `updateMarketTypeAndIndex`. */
	velocityMarkets?: VelocityMarketInfo[];
	/** `PriorityFeeStrategy` backing `getCustomStrategyResult()`; defaults to `AverageOverSlotsStrategy`. */
	customStrategy?: PriorityFeeStrategy;
	/** Which upstream API to sample from; defaults to `PriorityFeeMethod.SOLANA`. */
	priorityFeeMethod?: PriorityFeeMethod;
	/** Number of recent slots to consider when computing fee estimates; defaults to 50. */
	slotsToCheck?: number;
	/** Helius RPC URL; required for `PriorityFeeMethod.HELIUS` unless `connection`'s endpoint already points at Helius. */
	heliusRpcUrl?: string;
	/** Base URL of the Velocity-hosted priority fee service; required for `PriorityFeeMethod.VELOCITY`. */
	velocityPriorityFeeEndpoint?: string;
	/** Upper bound (micro-lamports per compute unit) applied to every `get*StrategyResult`/`getHeliusPriorityFeeLevel` return value, after `priorityFeeMultiplier`. Unset (`undefined`) means no clamp. */
	maxFeeMicroLamports?: number;
	/** Multiplier applied to the raw strategy result before `maxFeeMicroLamports` clamping; defaults to `1.0`. */
	priorityFeeMultiplier?: number;
};

/** Base config for `PriorityFeeSubscriberMap`, which only supports `PriorityFeeMethod.VELOCITY` (batched per-market fee lookups via `/batchPriorityFees`). */
type PriorityFeeSubscriberMapConfigBase = {
	/** Poll interval in milliseconds for `load()`; defaults to `DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS` (10s). */
	frequencyMs?: number;
	/** Markets to fetch fees for; can also be supplied later via `updateMarketTypeAndIndex`. */
	velocityMarkets?: VelocityMarketInfo[];
};

/** Configuration for `PriorityFeeSubscriberMap`. */
export type PriorityFeeSubscriberMapConfig =
	PriorityFeeSubscriberMapConfigBase & {
		/** Base URL of the Velocity-hosted priority fee service (queried via `/batchPriorityFees`). */
		velocityPriorityFeeEndpoint: string;
	};
