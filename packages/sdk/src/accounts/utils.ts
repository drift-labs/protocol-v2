import { DataAndSlot } from './types';
import { isVariant, PerpMarketAccount, SpotMarketAccount } from '../types';
import { OracleInfo } from '../oracles/types';
import { getOracleId } from '../oracles/oracleId';

/** Capitalizes the first character of `value` (e.g. for building Anchor event/method names from account names). */
export function capitalize(value: string): string {
	return value[0].toUpperCase() + value.slice(1);
}

/**
 * Unwraps a possibly-undefined `DataAndSlot<T>`, throwing if it hasn't loaded. Use this instead
 * of a bare non-null assertion when a subscriber's cached data must be present by this point.
 * @param dataAndSlot The cached data/slot pair to check, typically from `AccountSubscriber.dataAndSlot`.
 * @param message Error message to throw if `dataAndSlot` is undefined.
 * @returns The same `dataAndSlot`, narrowed to non-undefined.
 */
export function assertDataAndSlot<T>(
	dataAndSlot: DataAndSlot<T> | undefined,
	message: string
): DataAndSlot<T> {
	if (!dataAndSlot) {
		throw new Error(message);
	}
	return dataAndSlot;
}

/**
 * Scans cached perp/spot market data for perp markets with `status: delisted` and identifies
 * both the delisted market indexes and their oracles, excluding any oracle still in use by a
 * spot market or a non-delisted perp market (so a shared oracle isn't dropped out from under a
 * still-live market). Used by `VelocityClientAccountSubscriber` implementations to drive
 * `DelistedMarketSetting` (unsubscribe/discard) handling.
 * @param perpMarkets Currently cached perp market data/slots (entries with missing `data` are skipped).
 * @param spotMarkets Currently cached spot market data/slots, checked to avoid dropping oracles they still reference.
 * @returns `perpMarketIndexes` of delisted perp markets and `oracles` safe to stop tracking.
 */
export function findDelistedPerpMarketsAndOracles(
	perpMarkets: DataAndSlot<PerpMarketAccount>[],
	spotMarkets: DataAndSlot<SpotMarketAccount>[]
): { perpMarketIndexes: number[]; oracles: OracleInfo[] } {
	const delistedPerpMarketIndexes = [];
	const delistedOracles: OracleInfo[] = [];
	for (const perpMarket of perpMarkets) {
		if (!perpMarket || !perpMarket.data) {
			continue;
		}

		if (isVariant(perpMarket.data.status, 'delisted')) {
			delistedPerpMarketIndexes.push(perpMarket.data.marketIndex);
			delistedOracles.push({
				publicKey: perpMarket.data.oracle,
				source: perpMarket.data.oracleSource,
			});
		}
	}

	// make sure oracle isn't still used by a spot market or a live perp market
	const liveOracleIds = new Set<string>();
	for (const spotMarket of spotMarkets) {
		if (!spotMarket || !spotMarket.data) {
			continue;
		}
		liveOracleIds.add(
			getOracleId(spotMarket.data.oracle, spotMarket.data.oracleSource)
		);
	}
	for (const perpMarket of perpMarkets) {
		if (!perpMarket || !perpMarket.data) {
			continue;
		}
		if (!isVariant(perpMarket.data.status, 'delisted')) {
			liveOracleIds.add(
				getOracleId(perpMarket.data.oracle, perpMarket.data.oracleSource)
			);
		}
	}

	const filteredDelistedOracles = delistedOracles.filter(
		(delistedOracle) =>
			!liveOracleIds.has(
				getOracleId(delistedOracle.publicKey, delistedOracle.source)
			)
	);

	return {
		perpMarketIndexes: delistedPerpMarketIndexes,
		oracles: filteredDelistedOracles,
	};
}
