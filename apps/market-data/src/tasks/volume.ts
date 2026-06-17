import { TradeRecord } from '@backend/common';
import { MarketCacheRepository } from '@backend/redis';

const volumeCache = MarketCacheRepository();

export const processVolume = async (trade: TradeRecord): Promise<void> => {
	await volumeCache.storeTradeBucket(trade);
};
