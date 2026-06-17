import {
	enumToStr,
	getSpotMarkets,
	MarketData,
	MarketInfo,
	MarketSummary,
	PricingData,
	TradeRecord,
	VolumeData,
	VolumeInterval,
} from '@backend/common';
import { BASE_PRECISION_EXP, MarketType, QUOTE_PRECISION_EXP } from '@velocity-exchange/sdk';
import Decimal from 'decimal.js';
import { Redis } from '../client';

const SPOT_MARKETS = getSpotMarkets();
const DAY_IN_SECONDS = 86400;
const HOUR_IN_SECONDS = 3600;

export const MarketCacheRepository = () => {
	const redis = Redis();

	const BUCKET_KEY_TEMPLATE = '{volume}:{symbol}:{bucketTs}';
	const MARKET_VOLUME_PUBLISH_KEY = '{volume}:markets:24h:publish';
	const MARKET_VOLUME_KEY_24H = '{volume}:markets:24h:aggregates';
	const MARKET_VOLUME_KEY_1H = '{volume}:markets:1h:aggregates';
	const TOTAL_VOLUME_KEY_24H = '{volume}:total:24h';
	const TOTAL_VOLUME_KEY_1H = '{volume}:total:1h';
	const MARKETS_KEY = '{volume}:markets';
	const MARKET_SUMMARY_KEY = 'markets:summary';
	const MARKET_PRICING_KEY = 'markets:pricing';

	const getBucketKey = (symbol: string, bucketTs: number): string => {
		return BUCKET_KEY_TEMPLATE.replace('{symbol}', symbol).replace(
			'{bucketTs}',
			bucketTs.toString()
		);
	};

	const storeTradeBucket = async (trade: TradeRecord): Promise<void> => {
		const {
			symbol,
			marketIndex,
			marketType,
			ts,
			quoteAssetAmountFilled,
			baseAssetAmountFilled,
		} = trade;

		const quote = new Decimal(quoteAssetAmountFilled);
		const base = new Decimal(baseAssetAmountFilled);

		const bucketTs = Math.floor(ts / 10) * 10;
		const key = getBucketKey(symbol, bucketTs);

		await redis.executeInPipeline((pipeline) => {
			pipeline.hIncrByFloat(key, 'quote', parseFloat(quote.toString()));
			pipeline.hIncrByFloat(key, 'base', parseFloat(base.toString()));
			pipeline.expire(key, DAY_IN_SECONDS * 2);
			pipeline.sAdd(MARKETS_KEY, JSON.stringify({ symbol, marketIndex, marketType }));
		});
	};

	const getMarkets = async (): Promise<MarketInfo[]> => {
		const markets = await redis.sMembers(MARKETS_KEY);
		return markets.map((market) => JSON.parse(market) as MarketInfo);
	};

	const getBucketDataForTimeRange = async (
		symbol: string,
		startTs: number,
		endTs: number
	): Promise<{ quote: number; base: number }[]> => {
		const results = (await redis.executeInPipeline((pipeline) => {
			for (let t = startTs; t <= endTs; t += 10) {
				const key = getBucketKey(symbol, t);
				pipeline.hGetAll(key);
			}
		})) as unknown as { quote: number; base: number }[];

		return results.filter((data) => data && Object.keys(data).length > 0);
	};

	const calculateRollingVolumes = async (
		interval: VolumeInterval = VolumeInterval.TWENTY_FOUR_HOUR
	): Promise<{
		markets: VolumeData[];
		total: string;
	}> => {
		const now = Math.floor(Date.now() / 1000 / 10) * 10;
		const timeWindow = interval === VolumeInterval.ONE_HOUR ? HOUR_IN_SECONDS : DAY_IN_SECONDS;
		const cutoff = now - timeWindow;

		const markets = await getMarkets();
		const volumes: VolumeData[] = [];
		let totalQuoteVolume = new Decimal(0);

		await Promise.all(
			markets.map(async (market) => {
				const { symbol, marketIndex, marketType } = market;

				const bucketData = await getBucketDataForTimeRange(symbol, cutoff, now);

				let marketTotalQuote = new Decimal(0);
				let marketTotalBase = new Decimal(0);

				for (const data of bucketData) {
					const { quote, base } = data;
					if (quote) marketTotalQuote = marketTotalQuote.plus(new Decimal(quote));
					if (base) marketTotalBase = marketTotalBase.plus(new Decimal(base));
				}

				const basePrecision =
					marketType === enumToStr(MarketType.SPOT)
						? SPOT_MARKETS.find((x) => x.marketIndex === Number(marketIndex))
								?.precisionExp ?? BASE_PRECISION_EXP
						: QUOTE_PRECISION_EXP;

				volumes.push({
					symbol,
					quoteVolume: marketTotalQuote.toFixed(6),
					baseVolume: marketTotalBase.toFixed(basePrecision.toNumber()),
					marketIndex,
					marketType,
				});

				totalQuoteVolume = totalQuoteVolume.plus(marketTotalQuote);
			})
		);

		const totalQuoteVolumeStr = totalQuoteVolume.toFixed(6);

		const totalVolumeKey =
			interval === VolumeInterval.ONE_HOUR ? TOTAL_VOLUME_KEY_1H : TOTAL_VOLUME_KEY_24H;
		await redis.set(totalVolumeKey, totalQuoteVolumeStr);

		return {
			markets: volumes,
			total: totalQuoteVolumeStr,
		};
	};

	const setMarketVolumes = async ({
		markets,
		total,
		interval = VolumeInterval.TWENTY_FOUR_HOUR,
	}: {
		markets: VolumeData[];
		total: string;
		interval?: VolumeInterval;
	}): Promise<void> => {
		const volumeMap = markets.reduce(
			(acc, { symbol, quoteVolume, baseVolume, marketIndex, marketType }) => {
				acc[symbol] = JSON.stringify({
					quoteVolume,
					baseVolume,
					marketIndex,
					marketType,
				});
				return acc;
			},
			{} as Record<string, string>
		);

		if (!markets.length) return;

		const marketVolumeKey =
			interval === VolumeInterval.ONE_HOUR ? MARKET_VOLUME_KEY_1H : MARKET_VOLUME_KEY_24H;
		const totalVolumeKey =
			interval === VolumeInterval.ONE_HOUR ? TOTAL_VOLUME_KEY_1H : TOTAL_VOLUME_KEY_24H;

		await Promise.all([
			redis.hmSet(marketVolumeKey, volumeMap),
			redis.set(totalVolumeKey, total),
		]);
	};

	const getMarketsVolume = async ({
		interval = VolumeInterval.TWENTY_FOUR_HOUR,
	}: {
		interval: VolumeInterval;
	}): Promise<{
		markets: VolumeData[];
		total: string;
	} | null> => {
		const marketVolumeKey =
			interval === VolumeInterval.ONE_HOUR ? MARKET_VOLUME_KEY_1H : MARKET_VOLUME_KEY_24H;
		const totalVolumeKey =
			interval === VolumeInterval.ONE_HOUR ? TOTAL_VOLUME_KEY_1H : TOTAL_VOLUME_KEY_24H;

		const [data, totalQuoteVolume] = await Promise.all([
			redis.hGetAll(marketVolumeKey),
			redis.get(totalVolumeKey),
		]);

		if (!data || Object.keys(data).length === 0) {
			return null;
		}

		const volumes: VolumeData[] = [];
		for (const [symbol, volumeStr] of Object.entries(data)) {
			volumes.push({ ...(JSON.parse(volumeStr) as VolumeData), symbol });
		}

		return {
			markets: volumes,
			total: totalQuoteVolume || '0.000000',
		};
	};

	const publishMarketVolumes = async (data: {
		total: string;
		markets: VolumeData[];
	}): Promise<void> => {
		await redis.publish(MARKET_VOLUME_PUBLISH_KEY, JSON.stringify(data));
	};

	const getMarketSummary = async (): Promise<MarketSummary[]> => {
		const [pricingData, summaryData, volumeData24h] = await Promise.all([
			redis.get(MARKET_PRICING_KEY),
			redis.get(MARKET_SUMMARY_KEY),
			redis.hGetAll(MARKET_VOLUME_KEY_24H),
		]);

		if (!summaryData) return [];

		const summary = JSON.parse(summaryData) as MarketData[];
		const pricing = pricingData ? (JSON.parse(pricingData) as PricingData[]) : [];

		const pricingMap = new Map(pricing.map((p) => [p.symbol, p]));

		const volumeMap = new Map(
			Object.entries(volumeData24h || {}).map(([symbol, volumeStr]) => {
				const vol = JSON.parse(volumeStr as string) as VolumeData;
				return [symbol, vol];
			})
		);

		const aggregatedMarkets: MarketSummary[] = summary.map((market) => {
			const priceData = pricingMap.get(market.symbol);
			const volumeData = volumeMap.get(market.symbol);

			return {
				...market,
				oraclePrice: priceData?.oraclePrice ?? '',
				price: priceData?.price ?? '',
				...(priceData?.markPrice && { markPrice: priceData.markPrice }),
				quoteVolume: volumeData?.quoteVolume ?? '0',
				baseVolume: volumeData?.baseVolume ?? '0',
			};
		});

		return aggregatedMarkets;
	};

	const setMarketSummary = async (data: MarketData[]): Promise<void> => {
		await redis.set(MARKET_SUMMARY_KEY, JSON.stringify(data));
	};

	const publishMarketSummary = async (data: MarketSummary[]): Promise<void> => {
		await redis.publish(MARKET_SUMMARY_KEY, JSON.stringify(data));
	};

	const getMarketPricing = async (): Promise<PricingData[] | null> => {
		const markets = await redis.get(MARKET_PRICING_KEY);
		if (!markets) return null;
		return JSON.parse(markets);
	};

	const setMarketPricing = async (data: PricingData[]): Promise<void> => {
		await redis.set(MARKET_PRICING_KEY, JSON.stringify(data));
	};

	const publishMarketPricing = async (data: PricingData[]) => {
		await redis.publish(MARKET_PRICING_KEY, JSON.stringify(data));
	};

	return {
		storeTradeBucket,
		getMarkets,
		getBucketDataForTimeRange,
		calculateRollingVolumes,
		setMarketVolumes,
		getMarketsVolume,
		publishMarketVolumes,
		setMarketSummary,
		getMarketSummary,
		publishMarketSummary,
		getMarketPricing,
		setMarketPricing,
		publishMarketPricing,

		MARKET_VOLUME_PUBLISH_KEY,
		MARKET_SUMMARY_KEY,
		MARKET_PRICING_KEY,
	};
};
