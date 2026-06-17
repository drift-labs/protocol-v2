import { logger } from '@backend/common';
import {
	CandleCacheRepository,
	LeaderboardCacheRepository,
	MarketCacheRepository,
	StatsCacheRepository,
} from '@backend/redis';
import { Handler } from 'aws-lambda';
import { CacheProxyAction } from './types';

const { getCandlesBetweenTimestampsForResolution, getCandlesForResolution } =
	CandleCacheRepository();
const {
	getLiquidationStats,
	getBankruptcyStats,
	getVaultStats,
	getRateHistory,
	getFundingRateStats,
	getInsuranceFundStats,
	getTokenStats,
} = StatsCacheRepository();
const { getMarketsVolume, getMarketSummary } = MarketCacheRepository();
const { getLeaderboard, getLeaderboardRank, getUserVolumeAndFees } = LeaderboardCacheRepository();

export const handler: Handler<CacheProxyAction, any> = async (event) => {
	try {
		switch (event.type) {
			case 'getCandlesForResolution': {
				return getCandlesForResolution(event.params);
			}
			case 'getCandlesBetweenTimestampsForResolution': {
				return getCandlesBetweenTimestampsForResolution(event.params);
			}
			case 'getLiquidationStats': {
				return getLiquidationStats();
			}
			case 'getBankruptcyStats': {
				return getBankruptcyStats();
			}
			case 'getVaultStats': {
				return getVaultStats();
			}
			case 'getFundingRateStats': {
				return getFundingRateStats();
			}
			case 'getInsuranceFundStats': {
				return getInsuranceFundStats();
			}
			case 'getRateHistory': {
				return getRateHistory(event.params);
			}
			case 'getMarketSummary': {
				return getMarketSummary();
			}
			case 'getMarketsVolume': {
				return getMarketsVolume(event.params);
			}
			case 'getLeaderboard': {
				return getLeaderboard(event.params);
			}
			case 'getLeaderboardRank': {
				return getLeaderboardRank(event.params);
			}
			case 'getUserVolumeAndFees': {
				return getUserVolumeAndFees(event.params);
			}
			case 'getTokenStats': {
				return getTokenStats();
			}
		}
	} catch (error) {
		const { message } = error as Error;
		await logger.error(`Cache proxy error: ${message}`);
		throw error;
	}
};
