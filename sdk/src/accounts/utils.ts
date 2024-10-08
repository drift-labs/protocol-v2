import { PublicKey } from '@solana/web3.js';
import { DataAndSlot } from './types';
import { isVariant, PerpMarketAccount, SpotMarketAccount } from '../types';

export function capitalize(value: string): string {
	return value[0].toUpperCase() + value.slice(1);
}

export function findDelistedPerpMarketsAndOracles(
	perpMarkets: DataAndSlot<PerpMarketAccount>[],
	spotMarkets: DataAndSlot<SpotMarketAccount>[]
): { perpMarketIndexes: number[]; oracles: PublicKey[] } {
	const delistedPerpMarketIndexes = [];
	const delistedOracles = [];
	for (const perpMarket of perpMarkets) {
		if (!perpMarket.data) {
			continue;
		}

		if (isVariant(perpMarket.data.status, 'delisted')) {
			delistedPerpMarketIndexes.push(perpMarket.data.marketIndex);
			delistedOracles.push(perpMarket.data.amm.oracle);
		}
	}

	// make sure oracle isn't used by spot market
	const filteredDelistedOracles = [];
	for (const delistedOracle of delistedOracles) {
		for (const spotMarket of spotMarkets) {
			if (!spotMarket.data) {
				continue;
			}

			if (spotMarket.data.oracle.equals(delistedOracle)) {
				break;
			}
		}
		filteredDelistedOracles.push(delistedOracle);
	}

	return {
		perpMarketIndexes: delistedPerpMarketIndexes,
		oracles: filteredDelistedOracles,
	};
}
