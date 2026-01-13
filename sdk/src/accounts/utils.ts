import { DataAndSlot } from './types';
import {
	isVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	HistoricalOracleData,
} from '../types';
import { OracleInfo } from '../oracles/types';
import { getOracleId } from '../oracles/oracleId';
import { BN } from '@coral-xyz/anchor';

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

/**
 * Normalizes HistoricalOracleData to handle potential field name mismatch.
 * Anchor's camelCase conversion may produce lastOraclePriceTwap5Min (capital M)
 * instead of lastOraclePriceTwap5min (lowercase m).
 */
export function normalizeHistoricalOracleData(
	data: HistoricalOracleData | any
): HistoricalOracleData {
	// Handle potential field name mismatch: lastOraclePriceTwap5min vs lastOraclePriceTwap5Min
	const lastOraclePriceTwap5min =
		data.lastOraclePriceTwap5min ?? data.lastOraclePriceTwap5Min;

	return {
		lastOraclePrice: data.lastOraclePrice,
		lastOracleDelay: data.lastOracleDelay,
		lastOracleConf: data.lastOracleConf,
		lastOraclePriceTwap: data.lastOraclePriceTwap,
		lastOraclePriceTwap5min:
			lastOraclePriceTwap5min instanceof BN
				? lastOraclePriceTwap5min
				: new BN(lastOraclePriceTwap5min ?? 0),
		lastOraclePriceTwapTs: data.lastOraclePriceTwapTs,
	};
}

/**
 * Normalizes a PerpMarketAccount by fixing historicalOracleData field name issues.
 */
export function normalizePerpMarketAccount(
	account: PerpMarketAccount | any
): PerpMarketAccount {
	if (account.amm?.historicalOracleData) {
		account.amm.historicalOracleData = normalizeHistoricalOracleData(
			account.amm.historicalOracleData
		);
	}
	return account as PerpMarketAccount;
}

/**
 * Normalizes a SpotMarketAccount by fixing historicalOracleData field name issues.
 */
export function normalizeSpotMarketAccount(
	account: SpotMarketAccount | any
): SpotMarketAccount {
	if (account.historicalOracleData) {
		account.historicalOracleData = normalizeHistoricalOracleData(
			account.historicalOracleData
		);
	}
	return account as SpotMarketAccount;
}
