import { DriftEnv } from './config';
import { SpotMarketConfig, SpotMarkets } from './constants';
import { PerpMarketConfig, PerpMarkets } from './constants/perpMarkets';
import { isOneOfVariant } from './types';

export const getActivePerpMarkets = (driftEnv: DriftEnv): PerpMarketConfig[] => {
	return PerpMarkets[driftEnv ?? 'mainnet-beta'].filter((market) => (!market.marketStatus ||
        !isOneOfVariant(market.marketStatus, ['delisted', 'settlement'])));
};

export const getActiveSpotMarkets = (driftEnv: DriftEnv): SpotMarketConfig[] => {
	return SpotMarkets[driftEnv ?? 'mainnet-beta'].filter((market) => (!market.marketStatus ||
        !isOneOfVariant(market.marketStatus, ['delisted', 'settlement'])));
};