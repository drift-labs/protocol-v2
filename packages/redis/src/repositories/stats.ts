import {
	BankruptcyStats,
	FundingRateStats,
	LiquidationStats,
	logger,
	RateHistoryType,
	Rates,
	Vault,
} from '@backend/common';
import { Redis } from '../client';

export const StatsCacheRepository = () => {
	const redis = Redis();

	const LIQUIDATION_STATS_KEY = 'liquidation:stats';

	const setLiquidationStats = async (stats: LiquidationStats): Promise<void> => {
		try {
			await redis.set(LIQUIDATION_STATS_KEY, JSON.stringify(stats));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing liquidation stats: ${message}`);
		}
	};

	const getLiquidationStats = async (): Promise<LiquidationStats | null> => {
		try {
			const data = await redis.get(LIQUIDATION_STATS_KEY);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as LiquidationStats;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving liquidation stats: ${message}`);
			return null;
		}
	};

	const BANKRUPTCY_STATS_KEY = 'bankruptcy:stats';

	const setBankruptcyStats = async (stats: BankruptcyStats): Promise<void> => {
		try {
			await redis.set(BANKRUPTCY_STATS_KEY, JSON.stringify(stats));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing bankruptcy stats: ${message}`);
		}
	};

	const getBankruptcyStats = async (): Promise<BankruptcyStats | null> => {
		try {
			const data = await redis.get(BANKRUPTCY_STATS_KEY);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as BankruptcyStats;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving bankruptcy stats: ${message}`);
			return null;
		}
	};

	const VAULT_STATS_KEY = 'vaults:stats';

	const setVaultStats = async (stats: Vault[]) => {
		try {
			await redis.set(VAULT_STATS_KEY, JSON.stringify(stats));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing vault stats: ${message}`);
		}
	};

	const getVaultStats = async () => {
		try {
			const data = await redis.get(VAULT_STATS_KEY);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as Vault[];
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving vault stats: ${message}`);
			return null;
		}
	};

	const RATE_HISTORY_KEY = 'rateHistory:{type}:{symbol}';

	const setRateHistory = async ({
		symbol,
		type,
		rates,
	}: {
		symbol: string;
		type: RateHistoryType;
		rates: Rates;
	}) => {
		try {
			const formattedKey = RATE_HISTORY_KEY.replace('{type}', type).replace(
				'{symbol}',
				symbol
			);

			await redis.set(formattedKey, JSON.stringify(rates));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing rate history: ${message}`);
		}
	};

	const getRateHistory = async ({ symbol, type }: { symbol: string; type: RateHistoryType }) => {
		try {
			const formattedKey = RATE_HISTORY_KEY.replace('{type}', type).replace(
				'{symbol}',
				symbol
			);

			const data = await redis.get(formattedKey);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as Rates;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving rate history: ${message}`);
			return null;
		}
	};

	const FUNDING_RATES_KEY = 'fundingRates:average:stats';

	const setFundingRateStats = async (stats: FundingRateStats[]) => {
		try {
			await redis.set(FUNDING_RATES_KEY, JSON.stringify(stats));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing funding rate stats: ${message}`);
		}
	};

	const getFundingRateStats = async () => {
		try {
			const data = await redis.get(FUNDING_RATES_KEY);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as FundingRateStats[];
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving funding rate stats: ${message}`);
			return null;
		}
	};

	const INSURANCE_FUND_KEY = 'insuranceFund:stats';

	const setInsuranceFundStats = async (stats: any) => {
		try {
			await redis.set(INSURANCE_FUND_KEY, JSON.stringify(stats));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing insurance fund stats: ${message}`);
		}
	};

	const getInsuranceFundStats = async () => {
		try {
			const data = await redis.get(INSURANCE_FUND_KEY);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as any;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving insurance fund stats: ${message}`);
			return null;
		}
	};

	const TOKEN_KEY = 'token:stats';

	const setTokenStats = async (stats: any) => {
		try {
			await redis.set(TOKEN_KEY, JSON.stringify(stats));
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error storing token stats: ${message}`);
		}
	};

	const getTokenStats = async () => {
		try {
			const data = await redis.get(TOKEN_KEY);
			if (!data) {
				return null;
			}
			return JSON.parse(data) as any;
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error retrieving token stats: ${message}`);
			return null;
		}
	};

	return {
		setLiquidationStats,
		getLiquidationStats,
		setBankruptcyStats,
		getBankruptcyStats,
		setVaultStats,
		getVaultStats,
		setRateHistory,
		getRateHistory,
		setFundingRateStats,
		getFundingRateStats,
		setInsuranceFundStats,
		getInsuranceFundStats,
		setTokenStats,
		getTokenStats,
	};
};
