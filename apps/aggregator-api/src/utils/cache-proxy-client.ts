import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
	BankruptcyStats,
	CandleRecord,
	CandleResolutions,
	FundingRateStats,
	InsuranceFundStats,
	LeaderboardEntry,
	LeaderboardSort,
	LiquidationStats,
	MarketSummary,
	RateHistoryType,
	Rates,
	UserRankResult,
	Vault,
	VolumeData,
	VolumeInterval,
} from '@backend/common';
import {
	CandleCacheRepository,
	LeaderboardCacheRepository,
	MarketCacheRepository,
	StatsCacheRepository,
} from '@backend/redis';

export const CacheProxyClient = () => {
	const CACHE_PROXY_FUNCTION_NAME = process.env.CACHE_PROXY_FUNCTION_NAME;
	const candleRepo = CandleCacheRepository();
	const statsRepo = StatsCacheRepository();
	const marketsRepo = MarketCacheRepository();
	const leaderboardRepo = LeaderboardCacheRepository();

	const lambda = new LambdaClient({});

	const invoke = async <T>(payload: any): Promise<T> => {
		const { Payload, FunctionError } = await lambda.send(
			new InvokeCommand({
				FunctionName: CACHE_PROXY_FUNCTION_NAME,
				Payload: JSON.stringify(payload),
			})
		);

		if (FunctionError) {
			throw new Error(Buffer.from(Payload as Uint8Array).toString());
		}

		return JSON.parse(Buffer.from(Payload as Uint8Array).toString());
	};

	const getCandlesForResolution = async (params: {
		symbol: string;
		resolution: CandleResolutions;
		limit: number;
	}): Promise<CandleRecord[]> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return candleRepo.getCandlesForResolution(params);
		}

		return invoke({
			type: 'getCandlesForResolution',
			params,
		});
	};

	const getCandlesBetweenTimestampsForResolution = async (params: {
		symbol: string;
		resolution: CandleResolutions;
		startTs: number;
		endTs?: number;
		limit: number;
	}): Promise<CandleRecord[]> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return candleRepo.getCandlesBetweenTimestampsForResolution(params);
		}

		return invoke({
			type: 'getCandlesBetweenTimestampsForResolution',
			params,
		});
	};

	const getLiquidationStats = async (): Promise<LiquidationStats | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getLiquidationStats();
		}

		return invoke({
			type: 'getLiquidationStats',
		});
	};

	const getBankruptcyStats = async (): Promise<BankruptcyStats | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getBankruptcyStats();
		}

		return invoke({
			type: 'getBankruptcyStats',
		});
	};

	const getVaultStats = async (): Promise<Vault[] | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getVaultStats();
		}

		return invoke({
			type: 'getVaultStats',
		});
	};

	const getFundingRateStats = async (): Promise<FundingRateStats[] | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getFundingRateStats();
		}

		return invoke({
			type: 'getFundingRateStats',
		});
	};

	const getInsuranceFundStats = async (): Promise<InsuranceFundStats | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getInsuranceFundStats();
		}

		return invoke({
			type: 'getInsuranceFundStats',
		});
	};

	const getRateHistory = async (params: {
		symbol: string;
		type: RateHistoryType;
	}): Promise<Rates | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getRateHistory(params);
		}

		return invoke({
			type: 'getRateHistory',
			params,
		});
	};

	const getMarketsVolume = async (params: {
		interval: VolumeInterval;
	}): Promise<{
		markets: VolumeData[];
		total: string;
	} | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return marketsRepo.getMarketsVolume(params);
		}

		return invoke({
			type: 'getMarketsVolume',
			params,
		});
	};

	const getMarketSummary = async (): Promise<MarketSummary[]> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return marketsRepo.getMarketSummary();
		}

		return invoke({
			type: 'getMarketSummary',
		});
	};

	const getLeaderboard = async (params: {
		sort: LeaderboardSort;
		page: number;
		limit: number;
		start?: string;
		end?: string;
		symbol?: string;
	}): Promise<LeaderboardEntry[]> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return leaderboardRepo.getLeaderboard(params);
		}

		return invoke({
			type: 'getLeaderboard',
			params,
		});
	};

	const getLeaderboardRank = async (params: {
		authority: string;
		start?: string;
		end?: string;
		symbol?: string;
	}): Promise<UserRankResult> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return leaderboardRepo.getLeaderboardRank(params);
		}

		return invoke({
			type: 'getLeaderboardRank',
			params,
		});
	};

	const getUserVolumeAndFees = async (params: {
		user: string;
	}): Promise<{
		cumulativeMakerVolume: number;
		cumulativeTakerVolume: number;
		cumulativeRealizedPnl: number;
		cumulativeFeePaid: number;
		cumulativeFeeRebate: number;
	}> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return leaderboardRepo.getUserVolumeAndFees(params);
		}

		return invoke({
			type: 'getUserVolumeAndFees',
			params,
		});
	};

	const getTokenStats = async (): Promise<number | null> => {
		if (!CACHE_PROXY_FUNCTION_NAME) {
			return statsRepo.getTokenStats();
		}

		return invoke({
			type: 'getTokenStats',
		});
	};

	return {
		getCandlesForResolution,
		getCandlesBetweenTimestampsForResolution,
		getLiquidationStats,
		getBankruptcyStats,
		getVaultStats,
		getInsuranceFundStats,
		getFundingRateStats,
		getRateHistory,
		getMarketSummary,
		getMarketsVolume,
		getLeaderboard,
		getLeaderboardRank,
		getUserVolumeAndFees,
		getTokenStats,
	};
};
