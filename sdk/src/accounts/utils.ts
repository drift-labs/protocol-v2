import { DataAndSlot } from './types';
import { isVariant, PerpMarketAccount, SpotMarketAccount } from '../types';
import { OracleInfo } from '../oracles/types';
import { getOracleId } from '../oracles/oracleId';

export function capitalize(value: string): string {
	return value[0].toUpperCase() + value.slice(1);
}

export function findDelistedPerpMarketsAndOracles(
	perpMarkets: DataAndSlot<PerpMarketAccount>[],
	spotMarkets: DataAndSlot<SpotMarketAccount>[]
): { perpMarketIndexes: number[]; oracles: OracleInfo[] } {
	const delistedPerpMarketIndexes = [];
	const delistedOracles: OracleInfo[] = [];
	for (const perpMarket of perpMarkets) {
		if (!perpMarket.data) {
			continue;
		}

		if (isVariant(perpMarket.data.status, 'delisted')) {
			delistedPerpMarketIndexes.push(perpMarket.data.marketIndex);
			delistedOracles.push({
				publicKey: perpMarket.data.amm.oracle,
				source: perpMarket.data.amm.oracleSource,
			});
		}
	}

	// make sure oracle isn't used by spot market
	const filteredDelistedOracles = [];
	for (const delistedOracle of delistedOracles) {
		let isUsedBySpotMarket = false;
		for (const spotMarket of spotMarkets) {
			if (!spotMarket.data) {
				continue;
			}

			const delistedOracleId = getOracleId(
				delistedOracle.publicKey,
				delistedOracle.source
			);
			const spotMarketOracleId = getOracleId(
				spotMarket.data.oracle,
				spotMarket.data.oracleSource
			);
			if (spotMarketOracleId === delistedOracleId) {
				isUsedBySpotMarket = true;
				break;
			}
		}

		if (!isUsedBySpotMarket) {
			filteredDelistedOracles.push(delistedOracle);
		}
	}

	return {
		perpMarketIndexes: delistedPerpMarketIndexes,
		oracles: filteredDelistedOracles,
	};
}
