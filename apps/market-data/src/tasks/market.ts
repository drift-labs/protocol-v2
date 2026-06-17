import {
	bnStringToNumber,
	enumToStr,
	getPerpMarkets,
	getTimestamp,
	MarketData,
	PricingData,
	SerializedMarketFilter,
	UiStatus,
	VolumeInterval,
} from '@backend/common';
import { CandleRepository, FundingRateRepository } from '@backend/dynamodb';
import { CandleCacheRepository, MarketCacheRepository, Redis } from '@backend/redis';
import { HIDDEN_PERP_MARKET_INDEXES } from '@velocity-exchange/common';
import {
	AMM_RESERVE_PRECISION,
	BASE_PRECISION_EXP,
	BigNum,
	BN,
	calculateBidAskPrice,
	calculateFormattedLiveFundingRate,
	VelocityClient,
	getTokenAmount,
	MARGIN_PRECISION,
	MarketType,
	PRICE_PRECISION,
	PRICE_PRECISION_EXP,
	SpotBalanceType,
} from '@velocity-exchange/sdk';
import { Scheduler } from '../services/scheduler';

const {
	setMarketSummary,
	publishMarketSummary,
	calculateRollingVolumes,
	setMarketVolumes,
	setMarketPricing,
	publishMarketPricing,
	getMarketSummary,
} = MarketCacheRepository();
const {
	getCandlesBetweenTimestampsForResolution: getCandlesBetweenTimestampsForResolutionFromCache,
} = CandleCacheRepository();
const { getCandlesBetweenTimestampsForResolution } = CandleRepository();
const { getFundingRateRecordsBetweenTimestamps } = FundingRateRepository();
const { get } = Redis({
	overrideRedisUrl: process.env.ORDERBOOK_REDIS_URL,
});

const getPerpMarketUiStatus = (
	marketIndex: number,
	nowTs = Math.floor(Date.now() / 1000)
): { uiStatus: UiStatus; uiHideAtTs?: number } => {
	const hideAtTs = HIDDEN_PERP_MARKET_INDEXES.get(marketIndex);

	if (hideAtTs === undefined) {
		return {
			uiStatus: UiStatus.VISIBLE,
		};
	}

	if (nowTs < hideAtTs) {
		return {
			uiStatus: UiStatus.SCHEDULED_TO_HIDE,
			uiHideAtTs: hideAtTs,
		};
	}

	return {
		uiStatus: UiStatus.HIDDEN,
	};
};

const fetchFundingRateAvg = async (params: { symbol: string }) => {
	const { symbol } = params;

	const currentTs = Date.now();
	const afterTs = Math.floor(currentTs / 1000 - 24.33 * 60 * 60);

	const { records } = await getFundingRateRecordsBetweenTimestamps({
		id: symbol,
		startTs: afterTs,
		endTs: Math.floor(currentTs / 1000),
		limit: 24,
	});

	const numberOfRecords = records.length;
	const denominator = Math.max(numberOfRecords, Math.min(24, numberOfRecords ?? 1));

	const total = records.reduce((sum, record) => {
		const normalized = (record.fundingRate * 100) / record.oraclePriceTwap;
		return sum + normalized;
	}, 0);

	return {
		fundingRate: isFinite(total / denominator) ? total / denominator : null,
	};
};

const fetchMarkPriceFromDLOB = async ({
	marketIndex,
}: {
	marketIndex: number;
}): Promise<string | null> => {
	const orderbook = await get(`dlob:last_update_orderbook_perp_${marketIndex}_indicative`);
	if (!orderbook) return null;
	const { markPrice = null } = JSON.parse(orderbook);
	return markPrice;
};

const getMarketData = async ({ driftClient }: { driftClient: VelocityClient }) => {
	const perpMarkets = driftClient.getPerpMarketAccounts();
	const spotMarkets = driftClient.getSpotMarketAccounts();
	const markets: MarketData[] = [];

	const perpMarketConfigs = getPerpMarkets();
	const perpConfigMap = new Map(perpMarketConfigs.map((config) => [config.marketIndex, config]));
	await Promise.all([
		...perpMarkets.map(async (market) => {
			if (!market) return;
			const mmOraclePriceData = driftClient.getMMOracleDataForPerpMarket(market.marketIndex);
			const oracleData = driftClient.getOracleDataForPerpMarket(market.marketIndex);
			const symbol = Buffer.from(market.name).toString('utf8').trim();
			const marketConfig = perpConfigMap.get(market.marketIndex);
			const quoteSpotMarket = driftClient.getSpotMarketAccount(market.quoteSpotMarketIndex);
			const quoteAsset = Buffer.from(quoteSpotMarket!.name).toString('utf8').trim();

			const [candle24hAgo, candlesOver24H, fundingRate24hAvg] = await Promise.all([
				getCandlesBetweenTimestampsForResolution({
					symbol,
					startTs: getTimestamp({ days: -1 }),
					endTs: 0,
					resolution: '1',
					limit: 1,
				}),
				getCandlesBetweenTimestampsForResolutionFromCache({
					symbol,
					startTs: getTimestamp(),
					endTs: 0,
					resolution: '60',
					limit: 24,
				}),
				fetchFundingRateAvg({
					symbol,
				}),
			]);

			const currentPrice = candlesOver24H?.[0]?.fillClose ?? null;
			const price24hAgo = candle24hAgo?.[0]?.fillClose ?? null;

			const priceChange =
				currentPrice && price24hAgo
					? (currentPrice - price24hAgo).toFixed(PRICE_PRECISION_EXP.toNumber())
					: null;

			const priceChangePercent =
				currentPrice && price24hAgo && price24hAgo !== 0
					? (((currentPrice - price24hAgo) / price24hAgo) * 100).toFixed(2)
					: null;

			const high24h =
				candlesOver24H.length > 0
					? Math.max(...candlesOver24H.map((c: any) => c.fillHigh))
					: 0;
			const low24h =
				candlesOver24H.length > 0
					? Math.min(...candlesOver24H.map((c: any) => c.fillLow))
					: 0;

			const oracleHigh24h =
				candlesOver24H.length > 0
					? Math.max(...candlesOver24H.map((c: any) => c.oracleHigh))
					: 0;
			const oracleLow24h =
				candlesOver24H.length > 0
					? Math.min(...candlesOver24H.map((c: any) => c.oracleLow))
					: 0;

			let fundingRates;
			try {
				fundingRates = calculateFormattedLiveFundingRate(
					market,
					mmOraclePriceData,
					oracleData,
					'hour'
				);
			} catch (er) {
				// do nothing
			}

			markets.push({
				symbol,
				marketIndex: market.marketIndex,
				marketType: SerializedMarketFilter.PERP,
				...getPerpMarketUiStatus(market.marketIndex),
				openInterest: {
					long: bnStringToNumber(
						market.amm.baseAssetAmountLong.toString(),
						AMM_RESERVE_PRECISION
					).toString(),
					short: bnStringToNumber(
						market.amm.baseAssetAmountShort.toString(),
						AMM_RESERVE_PRECISION
					).toString(),
				},
				fundingRate: {
					short: fundingRates?.shortRate.toString() ?? '',
					long: fundingRates?.longRate.toString() ?? '',
				},
				fundingRate24h: fundingRate24hAvg.fundingRate?.toFixed(6),
				fundingRateUpdateTs: market.amm.lastFundingRateTs.toNumber(),
				priceChange24h: priceChange,
				priceChange24hPercent: priceChangePercent,
				priceHigh: {
					oracle: oracleHigh24h?.toFixed(6),
					fill: high24h?.toFixed(6),
				},
				priceLow: {
					oracle: oracleLow24h?.toFixed(6),
					fill: low24h?.toFixed(6),
				},
				status: enumToStr(market.status),
				baseAsset: marketConfig?.baseAssetSymbol ?? symbol.split('-')[0],
				quoteAsset: quoteAsset ?? 'USDC',
				precision: BASE_PRECISION_EXP.toNumber(),
				limits: {
					leverage: {
						min: 1,
						max:
							bnStringToNumber(
								market.marginRatioInitial.toString(),
								MARGIN_PRECISION
							) > 0
								? Math.floor(
										MARGIN_PRECISION.toNumber() / market.marginRatioInitial
								  )
								: 1,
					},
					amount: {
						min: bnStringToNumber(
							market.amm.minOrderSize.toString(),
							AMM_RESERVE_PRECISION
						),
						max:
							bnStringToNumber(
								market.amm.maxOpenInterest?.toString() || '0',
								AMM_RESERVE_PRECISION
							) || 0,
					},
				},
				fees: {
					maker:
						driftClient.getMarketFees(MarketType.PERP, market.marketIndex).makerFee *
						-1,
					taker: driftClient.getMarketFees(MarketType.PERP, market.marketIndex).takerFee,
				},
			});
		}),
		...spotMarkets.map(async (market) => {
			if (!market) return;
			const symbol = Buffer.from(market.name).toString('utf8').trim();

			const [candle24hAgo, candlesOver24H] = await Promise.all([
				getCandlesBetweenTimestampsForResolution({
					symbol,
					startTs: getTimestamp({ days: -1 }),
					endTs: 0,
					resolution: '1',
					limit: 1,
				}),
				getCandlesBetweenTimestampsForResolutionFromCache({
					symbol,
					startTs: getTimestamp(),
					endTs: 0,
					resolution: '60',
					limit: 24,
				}),
			]);

			const currentPrice = candlesOver24H?.[0]?.fillClose ?? null;
			const price24hAgo = candle24hAgo?.[0]?.fillClose ?? null;

			const priceChange =
				currentPrice && price24hAgo
					? (currentPrice - price24hAgo).toFixed(PRICE_PRECISION_EXP.toNumber())
					: null;

			const priceChangePercent =
				currentPrice && price24hAgo && price24hAgo !== 0
					? (((currentPrice - price24hAgo) / price24hAgo) * 100).toFixed(2)
					: null;

			const high24h =
				candlesOver24H.length > 0
					? Math.max(...candlesOver24H.map((c: any) => c.fillHigh))
					: 0;
			const low24h =
				candlesOver24H.length > 0
					? Math.min(...candlesOver24H.map((c: any) => c.fillLow))
					: 0;

			const oracleHigh24h =
				candlesOver24H.length > 0
					? Math.max(...candlesOver24H.map((c: any) => c.oracleHigh))
					: 0;
			const oracleLow24h =
				candlesOver24H.length > 0
					? Math.min(...candlesOver24H.map((c: any) => c.oracleLow))
					: 0;

			const depositBalance = getTokenAmount(
				market.depositBalance,
				market,
				SpotBalanceType.DEPOSIT
			);

			const borrowBalance = getTokenAmount(
				market.borrowBalance,
				market,
				SpotBalanceType.BORROW
			);

			markets.push({
				symbol,
				marketIndex: market.marketIndex,
				marketType: SerializedMarketFilter.SPOT,
				deposits: depositBalance.div(new BN(10).pow(new BN(market.decimals))).toString(),
				borrows: borrowBalance.div(new BN(10).pow(new BN(market.decimals))).toString(),
				priceChange24h: priceChange,
				priceChange24hPercent: priceChangePercent,
				priceHigh: {
					oracle: oracleHigh24h?.toFixed(6),
					fill: high24h?.toFixed(6),
				},
				priceLow: {
					oracle: oracleLow24h?.toFixed(6),
					fill: low24h?.toFixed(6),
				},
				status: enumToStr(market.status),
				precision: market.decimals,
				limits: {
					withdraw: {
						min: undefined,
						max: market.withdrawGuardThreshold
							.div(new BN(10).pow(new BN(market.decimals)))
							.toNumber(),
					},
					deposit: {
						min: undefined,
						max: market.maxTokenDeposits
							.div(new BN(10).pow(new BN(market.decimals)))
							.toNumber(),
					},
				},
			});
		}),
	]);

	return markets.sort((a, b) => a.marketIndex - b.marketIndex);
};

const getPriceUpdates = async ({ driftClient }: { driftClient: VelocityClient }) => {
	const perpMarkets = driftClient.getPerpMarketAccounts();
	const spotMarkets = driftClient.getSpotMarketAccounts();
	const priceUpdates: PricingData[] = [];

	await Promise.all([
		...perpMarkets.map(async (market) => {
			if (!market) return;
			const oracleData = driftClient.getOracleDataForPerpMarket(market.marketIndex);

			let markPrice;

			markPrice = await fetchMarkPriceFromDLOB({
				marketIndex: market.marketIndex,
			});

			if (!markPrice) {
				const mmOraclePriceData = driftClient.getMMOracleDataForPerpMarket(
					market.marketIndex
				);

				const [bid, ask] = calculateBidAskPrice(market.amm, mmOraclePriceData);

				markPrice = BigNum.from(bid, PRICE_PRECISION_EXP)
					.add(BigNum.from(ask, PRICE_PRECISION_EXP))
					.scale(1, 2)
					.toString();
			}

			const symbol = Buffer.from(market.name).toString('utf8').trim();

			const currentCandle = await getCandlesBetweenTimestampsForResolutionFromCache({
				symbol,
				startTs: getTimestamp(),
				endTs: 0,
				resolution: '1',
				limit: 1,
			});

			const currentPrice = currentCandle?.[0]?.fillClose ?? null;

			priceUpdates.push({
				symbol,
				marketIndex: market.marketIndex,
				marketType: SerializedMarketFilter.PERP,
				oraclePrice: bnStringToNumber(oracleData.price.toString(), PRICE_PRECISION).toFixed(
					PRICE_PRECISION_EXP.toNumber()
				),
				markPrice: bnStringToNumber(markPrice, PRICE_PRECISION).toFixed(
					PRICE_PRECISION_EXP.toNumber()
				),
				price: currentPrice?.toFixed(PRICE_PRECISION_EXP.toNumber()),
			});
		}),
		...spotMarkets.map(async (market) => {
			if (!market) return;
			const oracleData = driftClient.getOracleDataForSpotMarket(market.marketIndex);
			const symbol = Buffer.from(market.name).toString('utf8').trim();

			const currentCandle = await getCandlesBetweenTimestampsForResolutionFromCache({
				symbol,
				startTs: getTimestamp(),
				endTs: 0,
				resolution: '1',
				limit: 1,
			});

			const currentPrice = currentCandle?.[0]?.fillClose ?? null;

			priceUpdates.push({
				symbol,
				marketIndex: market.marketIndex,
				marketType: SerializedMarketFilter.SPOT,
				oraclePrice: bnStringToNumber(oracleData.price.toString(), PRICE_PRECISION).toFixed(
					PRICE_PRECISION_EXP.toNumber()
				),
				price: currentPrice?.toFixed(6),
			});
		}),
	]);

	return priceUpdates.sort((a, b) => a.marketIndex - b.marketIndex);
};

export const setupMarketPublishingTask = ({
	driftClient,
	scheduler,
}: {
	driftClient: VelocityClient;
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	scheduler.scheduleTask('pricing-updates', '*/3 * * * * *', async () => {
		const priceUpdates = await getPriceUpdates({ driftClient });
		await setMarketPricing(priceUpdates);
		await publishMarketPricing(priceUpdates);
	});

	scheduler.scheduleTask('market-updates', '* * * * *', async () => {
		const markets = await getMarketData({ driftClient });

		const data24h = await calculateRollingVolumes(VolumeInterval.TWENTY_FOUR_HOUR);
		await setMarketVolumes({ ...data24h, interval: VolumeInterval.TWENTY_FOUR_HOUR });
		const data1h = await calculateRollingVolumes(VolumeInterval.ONE_HOUR);
		await setMarketVolumes({ ...data1h, interval: VolumeInterval.ONE_HOUR });

		await setMarketSummary(markets);

		const aggregatedSummary = await getMarketSummary();
		await publishMarketSummary(aggregatedSummary);
	});
};
