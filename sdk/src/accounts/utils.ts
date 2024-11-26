import { PublicKey } from '@solana/web3.js';
import { DataAndSlot } from './types';
import { isVariant, PerpMarketAccount, SpotMarketAccount } from '../types';
import { OracleInfo } from '../oracles/types';

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
		for (const spotMarket of spotMarkets) {
			if (!spotMarket.data) {
				continue;
			}

			if (spotMarket.data.oracle.equals(delistedOracle.publicKey)) {
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
