import {
	CandleResolutions,
	getPerpMarkets,
	getSpotMarkets,
	getTimestamp,
	getTimestampDay,
	roundToHour,
	SerializedMarketFilter,
	VolumeInterval,
} from '@backend/common';
import { CandleRepository } from '@backend/dynamodb';
import Bottleneck from 'bottleneck';
import Decimal from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';
import { PRICE_PRECISION_EXP, QUOTE_PRECISION_EXP, SpotMarketConfig } from '../../sdk';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const limiter = new Bottleneck({
	maxConcurrent: 30,
});

const marketRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const {
		getMarketsVolume,
		getMarketSummary,
		getCandlesBetweenTimestampsForResolution: getCandlesBetweenTimestampsForResolutionFromCache,
	} = CacheProxyClient();
	const { getCandlesBetweenTimestampsForResolution } = CandleRepository();

	const calculateVolumeFromCandles = async (
		startTs: number,
		endTs: number,
		resolution: CandleResolutions,
		limit: number
	) => {
		const spotMarkets = getSpotMarkets().map((m) => ({
			...m,
			marketType: SerializedMarketFilter.SPOT,
		}));

		const perpMarkets = getPerpMarkets().map((m) => ({
			...m,
			marketType: SerializedMarketFilter.PERP,
		}));

		const markets = [...perpMarkets, ...spotMarkets];

		const marketVolumes = await Promise.all(
			markets.map((market) =>
				limiter.schedule(async () => {
					const candles = await getCandlesBetweenTimestampsForResolution({
						symbol: market.symbol,
						startTs: endTs,
						endTs: startTs,
						resolution,
						limit,
					});

					let baseVolume = Decimal(0);
					let quoteVolume = Decimal(0);

					for (const candle of candles || []) {
						baseVolume = baseVolume.plus(Decimal(candle.baseVolume));
						quoteVolume = quoteVolume.plus(Decimal(candle.quoteVolume));
					}

					const basePrecision =
						market.marketType === SerializedMarketFilter.SPOT
							? (market as SpotMarketConfig).precisionExp
							: QUOTE_PRECISION_EXP;

					return {
						symbol: market.symbol,
						baseVolume: baseVolume.toFixed(basePrecision.toNumber()),
						quoteVolume: quoteVolume.toFixed(6),
						marketIndex: market.marketIndex,
						marketType: market.marketType,
					};
				})
			)
		);

		const totalQuoteVolume = marketVolumes.reduce(
			(acc, m) => acc.plus(Decimal(m.quoteVolume)),
			Decimal(0)
		);

		return {
			markets: marketVolumes.sort((a, b) => a.marketIndex - b.marketIndex),
			total: totalQuoteVolume.toFixed(6),
		};
	};

	fastify.get(
		'',
		{
			schema: {
				description: `Get a summary of market data`,
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							markets: {
								type: 'array',
								items: {
									properties: {
										symbol: { type: 'string' },
										marketIndex: { type: 'number' },
										marketType: { type: 'string' },
										uiStatus: {
											type: 'string',
											enum: ['visible', 'hidden', 'scheduled_to_hide'],
										},
										uiHideAtTs: { type: 'number' },
										baseAsset: { type: 'string' },
										quoteAsset: { type: 'string' },
										status: { type: 'string' },
										precision: { type: 'number' },
										limits: {
											type: 'object',
											properties: {
												leverage: {
													type: 'object',
													properties: {
														min: { type: 'number' },
														max: { type: 'number' },
													},
												},
												amount: {
													type: 'object',
													properties: {
														min: { type: 'number' },
														max: { type: 'number' },
													},
												},
												withdraw: {
													type: 'object',
													properties: {
														min: { type: 'number' },
														max: { type: 'number' },
													},
												},
												deposit: {
													type: 'object',
													properties: {
														min: { type: 'number' },
														max: { type: 'number' },
													},
												},
											},
										},
										fees: {
											type: 'object',
											properties: {
												maker: { type: 'number' },
												taker: { type: 'number' },
											},
										},
										oraclePrice: { type: 'string' },
										markPrice: { type: 'string' },
										baseVolume: { type: 'string' },
										quoteVolume: { type: 'string' },
										deposits: { type: 'string' },
										borrows: { type: 'string' },
										openInterest: {
											type: 'object',
											properties: {
												long: { type: 'string' },
												short: { type: 'string' },
											},
										},
										fundingRate: {
											type: 'object',
											properties: {
												long: { type: 'string' },
												short: { type: 'string' },
											},
										},
										fundingRate24h: { type: 'string' },
										fundingRateUpdateTs: { type: 'number' },
										price: { type: 'string' },
										priceChange24h: { type: 'string' },
										priceChange24hPercent: { type: 'string' },
										priceHigh: {
											type: 'object',
											properties: {
												oracle: { type: 'string' },
												fill: { type: 'string' },
											},
										},
										priceLow: {
											type: 'object',
											properties: {
												oracle: { type: 'string' },
												fill: { type: 'string' },
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async function (_, reply) {
			const data = await getMarketSummary();
			const sortedMarkets = data.sort((a, b) => a.marketIndex - b.marketIndex);
			return reply.send({
				success: true,
				markets: sortedMarkets,
			});
		}
	);

	fastify.get<{
		Params: {
			interval: VolumeInterval;
		};
	}>(
		'/volume/:interval',
		{
			schema: {
				params: {
					type: 'object',
					properties: {
						interval: {
							type: 'string',
							default: VolumeInterval.TWENTY_FOUR_HOUR,
							enum: Object.values(VolumeInterval),
						},
					},
				},
				description: `Get rolling market volume data for specified interval`,
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							total: { type: 'string' },
							markets: {
								type: 'array',
								items: {
									properties: {
										symbol: { type: 'string' },
										quoteVolume: { type: 'string' },
										baseVolume: { type: 'string' },
										marketIndex: { type: 'number' },
										marketType: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { interval } = request.params;

			if (interval === VolumeInterval.THIRTY_DAYS) {
				const endTs = getTimestampDay();
				const startTs = getTimestampDay({ days: -30 });
				const { markets, total } = await calculateVolumeFromCandles(
					startTs,
					endTs,
					'D',
					31
				);

				return reply.send({
					success: true,
					total,
					markets,
				});
			}

			// Handle 1h and 24h using existing cache
			const data = await getMarketsVolume({ interval });
			const sortedMarkets = data?.markets.sort((a, b) => a.marketIndex - b.marketIndex);
			return reply.send({
				success: true,
				total: data?.total,
				markets: sortedMarkets,
			});
		}
	);

	fastify.get<{
		Querystring: {
			startTs: number;
			endTs: number;
		};
	}>(
		'/volume',
		{
			schema: {
				tags: ['Stats'],
				querystring: {
					type: 'object',
					required: ['startTs', 'endTs'],
					properties: {
						startTs: {
							type: 'number',
							description: 'Start timestamp in seconds (Unix epoch)',
						},
						endTs: {
							type: 'number',
							description: 'End timestamp in seconds (Unix epoch)',
						},
					},
				},
				description:
					'Get historical market volume data bucketed into 1-hour intervals. Time range must be between 1 and 24 hours (rounded down to nearest hour).',
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							total: { type: 'string' },
							startTs: { type: 'number' },
							endTs: { type: 'number' },
							markets: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										symbol: { type: 'string' },
										baseVolume: { type: 'string' },
										quoteVolume: { type: 'string' },
										marketIndex: { type: 'number' },
										marketType: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		async (request, reply) => {
			const { startTs, endTs } = request.query;

			const roundedStart = roundToHour(startTs);
			const roundedEnd = roundToHour(endTs);

			if (roundedStart >= roundedEnd) {
				return reply.status(400).send({
					success: false,
					error: 'startTs must be less than endTs after rounding to the nearest hour',
				});
			}

			const duration = roundedEnd - roundedStart;
			if (duration < 3600 || duration > 86400) {
				return reply.status(400).send({
					success: false,
					error: 'Time range must be between 1 and 24 hours (after rounding)',
				});
			}

			const { markets, total } = await calculateVolumeFromCandles(
				roundedStart,
				roundedEnd,
				'60',
				24
			);

			return reply.send({
				success: true,
				startTs: roundedStart,
				endTs: roundedEnd,
				total,
				markets,
			});
		}
	);

	fastify.get(
		'/prices',
		{
			schema: {
				tags: ['Stats'],
				description: 'Get the 24-hour price change and percentage change for all markets.',
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							markets: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										symbol: { type: 'string' },
										currentPrice: { type: 'string' },
										price24hAgo: { type: 'string' },
										priceChange: { type: 'string' },
										priceChangePercent: { type: 'string' },
										marketIndex: { type: 'number' },
										marketType: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		async (_, reply) => {
			const spotMarkets = getSpotMarkets().map((m) => ({
				...m,
				marketType: SerializedMarketFilter.SPOT,
			}));

			const perpMarkets = getPerpMarkets().map((m) => ({
				...m,
				marketType: SerializedMarketFilter.PERP,
			}));

			const markets = [...perpMarkets, ...spotMarkets];

			const priceStats = await Promise.all(
				markets.map((market) =>
					limiter.schedule(async () => {
						const currentCandle =
							await getCandlesBetweenTimestampsForResolutionFromCache({
								symbol: market.symbol,
								startTs: getTimestamp(),
								endTs: 0,
								resolution: '1',
								limit: 1,
							});

						// Need to use dynamo because only store 1k candles in cache
						const candle24hAgo = await getCandlesBetweenTimestampsForResolution({
							symbol: market.symbol,
							startTs: getTimestamp({ days: -1 }),
							endTs: 0,
							resolution: '1',
							limit: 1,
						});

						const currentPrice = currentCandle?.[0]?.fillClose ?? null;
						const price24hAgo = candle24hAgo?.[0]?.fillClose ?? null;

						const priceChange =
							currentPrice && price24hAgo
								? (currentPrice - price24hAgo).toFixed(
										PRICE_PRECISION_EXP.toNumber()
								  )
								: null;

						const priceChangePercent =
							currentPrice && price24hAgo && price24hAgo !== 0
								? (((currentPrice - price24hAgo) / price24hAgo) * 100).toFixed(2)
								: null;

						return {
							symbol: market.symbol,
							currentPrice: currentPrice,
							price24hAgo: price24hAgo,
							priceChange: priceChange,
							priceChangePercent: priceChangePercent,
							marketIndex: market.marketIndex,
							marketType: market.marketType,
						};
					})
				)
			);

			return reply.send({
				success: true,
				markets: priceStats,
			});
		}
	);
};

export default marketRoutes;
