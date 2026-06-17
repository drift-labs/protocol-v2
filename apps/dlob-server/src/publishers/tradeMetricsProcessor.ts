import {
	CompetitiveLiquidity,
	getAbsoluteBpsDiff,
	getCompetitiveLiquidity,
	getIndicativeBpsBucket,
	getIndicativeDirectionBucket,
	getFillTimestampMs,
	getFillPrice,
	getFillSide,
	getMakerMetricAttrs,
	getQuotedFillReferencePrice,
	getQuoteTimestampMs,
	getQuoteValueOnBook,
	getSignedBpsDiff,
	IndicativeQuoteBlob,
} from './tradeMetrics';

export type FillEvent = {
	ts: number;
	marketIndex: number;
	marketType: string;
	filler?: string;
	takerFee: number;
	makerFee: number;
	quoteAssetAmountSurplus: number;
	baseAssetAmountFilled: number;
	quoteAssetAmountFilled: number;
	taker?: string;
	takerOrderId?: number;
	takerOrderDirection?: string;
	takerOrderBaseAssetAmount: number;
	takerOrderCumulativeBaseAssetAmountFilled: number;
	takerOrderCumulativeQuoteAssetAmountFilled: number;
	maker?: string;
	makerIndicativeKey?: string;
	makerOrderId?: number;
	makerOrderDirection?: string;
	makerOrderBaseAssetAmount: number;
	makerOrderCumulativeBaseAssetAmountFilled: number;
	makerOrderCumulativeQuoteAssetAmountFilled: number;
	oraclePrice: number;
	txSig: string;
	slot: number;
	fillRecordId?: number;
	action: string;
	actionExplanation: string;
	referrerReward: number;
	bitFlags: number;
};

type MarketQuoteCacheEntry = {
	poller?: ReturnType<typeof setInterval>;
	historyByMaker: Map<string, IndicativeQuoteBlob[]>;
};

type MarketQuoteEvaluation = {
	maker: string;
	totalQuoteValueOnBook: number;
	competitiveQuoteValueOnBook: number;
	quotedFillReferencePrice?: number;
	competitiveLiquidity?: CompetitiveLiquidity;
};

type CounterSink = {
	add(value: number, attributes: Record<string, string | number>): void;
};

type GaugeSink = {
	setLatestValue(
		value: number,
		attributes: Record<string, string | number>
	): void;
};

export type TradeMetricsSinks = {
	marketFillCount: CounterSink;
	indicativePresenceCount: CounterSink;
	indicativeCompetitiveOpportunityCount: CounterSink;
	indicativeCompetitiveFillCount: CounterSink;
	indicativeCompetitiveOpportunityNotional: CounterSink;
	indicativeCompetitiveCapturedNotional: CounterSink;
	indicativeFillVsQuoteOutcomeCount: CounterSink;
	indicativeTotalSizeOnBookGauge: GaugeSink;
	indicativeCompetitiveSizeOnBookGauge: GaugeSink;
};

export type PublisherRedisClient = {
	publish(key: string, value: any): Promise<number> | number;
};

export type IndicativeQuotesRedisClient = {
	smembers(key: string): Promise<string[]>;
	get<T>(key: string): Promise<T>;
};

export const createTradeMetricsProcessor = ({
	redisClientPrefix,
	indicativeQuoteMaxAgeMs,
	indicativeQuotesCacheTtlMs,
	indicativeQuoteHistoryWindowMs = 5000,
	spotMarketPrecisionResolver,
	publisherRedisClient,
	indicativeQuotesRedisClient,
	metrics,
	nowMsProvider = Date.now,
	onError,
}: {
	redisClientPrefix: string;
	indicativeQuoteMaxAgeMs: number;
	indicativeQuotesCacheTtlMs: number;
	indicativeQuoteHistoryWindowMs?: number;
	spotMarketPrecisionResolver: (marketIndex: number) => number | undefined;
	publisherRedisClient: PublisherRedisClient;
	indicativeQuotesRedisClient: IndicativeQuotesRedisClient;
	metrics: TradeMetricsSinks;
	nowMsProvider?: () => number;
	onError?: (error: unknown) => void;
}) => {
	const marketQuoteCache = new Map<string, MarketQuoteCacheEntry>();

	const getMarketKey = (
		fillEvent: Pick<FillEvent, 'marketType' | 'marketIndex'>
	) => `${fillEvent.marketType}_${fillEvent.marketIndex}`;

	const fetchLatestQuoteBlobs = async (
		fillEvent: Pick<FillEvent, 'marketType' | 'marketIndex'>
	) => {
		const mmSetKey = `market_mms_${fillEvent.marketType}_${fillEvent.marketIndex}`;
		const makers = await indicativeQuotesRedisClient.smembers(mmSetKey);
		if (!makers.length) {
			return [];
		}

		const quoteBlobs = (await Promise.all(
			makers.map((maker) =>
				indicativeQuotesRedisClient.get<IndicativeQuoteBlob | null>(
					`mm_quotes_v2_${fillEvent.marketType}_${fillEvent.marketIndex}_${maker}`
				)
			)
		)) as (IndicativeQuoteBlob | null)[];

		return makers.map((maker, idx) => ({
			maker,
			quoteBlob: quoteBlobs[idx],
		}));
	};

	const pruneQuoteHistory = (
		historyByMaker: Map<string, IndicativeQuoteBlob[]>,
		nowMs: number
	) => {
		for (const [maker, history] of historyByMaker.entries()) {
			const pruned = history.filter((quoteBlob) => {
				const quoteTsMs = getQuoteTimestampMs(quoteBlob);
				return (
					quoteTsMs !== undefined &&
					nowMs - quoteTsMs <= indicativeQuoteHistoryWindowMs
				);
			});
			if (pruned.length) {
				historyByMaker.set(maker, pruned);
			} else {
				historyByMaker.delete(maker);
			}
		}
	};

	const upsertQuoteHistory = (
		historyByMaker: Map<string, IndicativeQuoteBlob[]>,
		quoteBlobs: Array<{ maker: string; quoteBlob: IndicativeQuoteBlob | null }>,
		nowMs: number
	) => {
		for (const { maker, quoteBlob } of quoteBlobs) {
			if (!quoteBlob) {
				continue;
			}
			const quoteTsMs = getQuoteTimestampMs(quoteBlob);
			if (quoteTsMs === undefined) {
				continue;
			}
			const history = historyByMaker.get(maker) ?? [];
			const lastQuoteTsMs = history.length
				? getQuoteTimestampMs(history[history.length - 1])
				: undefined;
			if (lastQuoteTsMs !== quoteTsMs) {
				history.push(quoteBlob);
				historyByMaker.set(maker, history);
			}
		}
		pruneQuoteHistory(historyByMaker, nowMs);
	};

	const ensureMarketPolling = (
		fillEvent: Pick<FillEvent, 'marketType' | 'marketIndex'>
	) => {
		const marketKey = getMarketKey(fillEvent);
		const existing = marketQuoteCache.get(marketKey);
		if (existing?.poller) {
			return;
		}

		const historyByMaker =
			existing?.historyByMaker ?? new Map<string, IndicativeQuoteBlob[]>();
		const pollQuotes = async () => {
			try {
				const quoteBlobs = await fetchLatestQuoteBlobs(fillEvent);
				upsertQuoteHistory(historyByMaker, quoteBlobs, nowMsProvider());
			} catch (error) {
				onError?.(error);
			}
		};

		void pollQuotes();
		const poller = setInterval(() => {
			void pollQuotes();
		}, indicativeQuotesCacheTtlMs);
		poller.unref?.();
		marketQuoteCache.set(marketKey, { historyByMaker, poller });
	};

	const getMarketQuotes = async (
		fillEvent: FillEvent,
		side: 'long' | 'short',
		fillPrice: number,
		fillTsMs: number
	): Promise<MarketQuoteEvaluation[]> => {
		const marketKey = getMarketKey(fillEvent);
		ensureMarketPolling(fillEvent);
		const marketQuoteEntry = marketQuoteCache.get(marketKey);
		const historyByMaker = marketQuoteEntry?.historyByMaker ?? new Map();
		if (!historyByMaker.size) {
			const latestQuoteBlobs = await fetchLatestQuoteBlobs(fillEvent);
			upsertQuoteHistory(historyByMaker, latestQuoteBlobs, nowMsProvider());
		}
		pruneQuoteHistory(historyByMaker, nowMsProvider());
		const mapQuoteBlob = (
			maker: string,
			quoteBlob: IndicativeQuoteBlob | null
		): MarketQuoteEvaluation => {
			const spotPrecision =
				fillEvent.marketType === 'spot'
					? spotMarketPrecisionResolver(fillEvent.marketIndex)
					: undefined;
			const competitiveLiquidity = getCompetitiveLiquidity(
				maker,
				fillEvent,
				side,
				fillPrice,
				quoteBlob,
				spotPrecision
			);
			const quoteTsMs = getQuoteTimestampMs(quoteBlob);
			const quoteAgeMs =
				quoteTsMs !== undefined ? fillTsMs - quoteTsMs : Infinity;
			const isFresh = quoteAgeMs >= 0 && quoteAgeMs <= indicativeQuoteMaxAgeMs;

			return {
				maker,
				totalQuoteValueOnBook: isFresh
					? getQuoteValueOnBook(fillEvent, side, quoteBlob, spotPrecision)
					: 0,
				competitiveQuoteValueOnBook:
					isFresh && competitiveLiquidity ? competitiveLiquidity.quoteValue : 0,
				quotedFillReferencePrice: isFresh
					? getQuotedFillReferencePrice(
							fillEvent,
							side,
							fillEvent.baseAssetAmountFilled,
							quoteBlob,
							spotPrecision
					  )
					: undefined,
				competitiveLiquidity: isFresh ? competitiveLiquidity : undefined,
			};
		};
		const quoteBlobs = [...historyByMaker.entries()].map(([maker, history]) => {
			const quoteBlob =
				[...history].reverse().find((candidate) => {
					const quoteTsMs = getQuoteTimestampMs(candidate);
					return quoteTsMs !== undefined && quoteTsMs <= fillTsMs;
				}) ?? null;
			return { maker, quoteBlob };
		});
		return quoteBlobs.map(({ maker, quoteBlob }) =>
			mapQuoteBlob(maker, quoteBlob)
		);
	};

	const processFillEvent = async (fillEvent: FillEvent) => {
		await publisherRedisClient.publish(
			`${redisClientPrefix}trades_${fillEvent.marketType}_${fillEvent.marketIndex}`,
			fillEvent
		);

		const fillSide = getFillSide(fillEvent);
		const fillPrice = getFillPrice(fillEvent);
		if (
			!fillSide ||
			!fillPrice ||
			!Number.isFinite(fillPrice) ||
			fillPrice <= 0
		) {
			return;
		}

		const marketMetricAttrs = {
			market_index: fillEvent.marketIndex,
			market_type: fillEvent.marketType,
			side: fillSide,
		};
		metrics.marketFillCount.add(1, marketMetricAttrs);

		try {
			const marketQuoteEvaluations = await getMarketQuotes(
				fillEvent,
				fillSide,
				fillPrice,
				getFillTimestampMs(fillEvent.ts)
			);
			const marketQuotes = marketQuoteEvaluations
				.map((evaluation) => evaluation.competitiveLiquidity)
				.filter((quote): quote is CompetitiveLiquidity => !!quote);

			for (const evaluation of marketQuoteEvaluations) {
				const attrs = getMakerMetricAttrs(
					fillEvent,
					evaluation.maker,
					fillSide
				);
				if (evaluation.totalQuoteValueOnBook > 0) {
					metrics.indicativePresenceCount.add(1, attrs);
				}
				metrics.indicativeTotalSizeOnBookGauge.setLatestValue(
					evaluation.totalQuoteValueOnBook,
					attrs
				);
				metrics.indicativeCompetitiveSizeOnBookGauge.setLatestValue(
					evaluation.competitiveQuoteValueOnBook,
					attrs
				);
			}

			for (const quote of marketQuotes) {
				const attrs = getMakerMetricAttrs(fillEvent, quote.maker, fillSide);
				const opportunitySize = Math.min(
					fillEvent.baseAssetAmountFilled,
					quote.size
				);
				const opportunityNotional = opportunitySize * fillPrice;
				metrics.indicativeCompetitiveOpportunityCount.add(1, attrs);
				metrics.indicativeCompetitiveOpportunityNotional.add(
					opportunityNotional,
					attrs
				);

				if (fillEvent.makerIndicativeKey === quote.maker) {
					metrics.indicativeCompetitiveFillCount.add(1, attrs);
					metrics.indicativeCompetitiveCapturedNotional.add(
						Math.min(fillEvent.baseAssetAmountFilled, opportunitySize) *
							fillPrice,
						attrs
					);
				}
			}

			const fillMakerEvaluation = fillEvent.makerIndicativeKey
				? marketQuoteEvaluations.find(
						(evaluation) => evaluation.maker === fillEvent.makerIndicativeKey
				  )
				: undefined;
			if (
				fillEvent.makerIndicativeKey &&
				fillMakerEvaluation &&
				fillMakerEvaluation.totalQuoteValueOnBook > 0 &&
				fillMakerEvaluation.quotedFillReferencePrice &&
				Number.isFinite(fillMakerEvaluation.quotedFillReferencePrice)
			) {
				const fillMakerAttrs = getMakerMetricAttrs(
					fillEvent,
					fillMakerEvaluation.maker,
					fillSide
				);
				metrics.indicativeFillVsQuoteOutcomeCount.add(1, {
					...fillMakerAttrs,
					bucket: getIndicativeBpsBucket(
						getAbsoluteBpsDiff(
							fillPrice,
							fillMakerEvaluation.quotedFillReferencePrice
						)
					),
					direction: getIndicativeDirectionBucket(
						getSignedBpsDiff(
							fillPrice,
							fillMakerEvaluation.quotedFillReferencePrice
						)
					),
				});
			}
		} catch (error) {
			onError?.(error);
		}
	};

	return {
		processFillEvent,
	};
};
