import { describe, expect, it } from '@jest/globals';
import {
	createTradeMetricsProcessor,
	FillEvent,
	TradeMetricsSinks,
} from '../tradeMetricsProcessor';

type CounterTestSink = {
	calls: Array<{ value: number; attributes: Record<string, string | number> }>;
	add: (value: number, attributes: Record<string, string | number>) => void;
};

type GaugeTestSink = {
	calls: Array<{ value: number; attributes: Record<string, string | number> }>;
	setLatestValue: (
		value: number,
		attributes: Record<string, string | number>
	) => void;
};

const createCounterSink = (): CounterTestSink => {
	const calls: Array<{
		value: number;
		attributes: Record<string, string | number>;
	}> = [];
	return {
		calls,
		add: (value: number, attributes: Record<string, string | number>) => {
			calls.push({ value, attributes });
		},
	};
};

const createGaugeSink = (): GaugeTestSink => {
	const calls: Array<{
		value: number;
		attributes: Record<string, string | number>;
	}> = [];
	return {
		calls,
		setLatestValue: (
			value: number,
			attributes: Record<string, string | number>
		) => {
			calls.push({ value, attributes });
		},
	};
};

type TestTradeMetricsSinks = TradeMetricsSinks & {
	marketFillCount: CounterTestSink;
	indicativePresenceCount: CounterTestSink;
	indicativeCompetitiveOpportunityCount: CounterTestSink;
	indicativeCompetitiveFillCount: CounterTestSink;
	indicativeCompetitiveOpportunityNotional: CounterTestSink;
	indicativeCompetitiveCapturedNotional: CounterTestSink;
	indicativeFillVsQuoteOutcomeCount: CounterTestSink;
	indicativeTotalSizeOnBookGauge: GaugeTestSink;
	indicativeCompetitiveSizeOnBookGauge: GaugeTestSink;
};

const createMetricSinks = (): TestTradeMetricsSinks => ({
	marketFillCount: createCounterSink(),
	indicativePresenceCount: createCounterSink(),
	indicativeCompetitiveOpportunityCount: createCounterSink(),
	indicativeCompetitiveFillCount: createCounterSink(),
	indicativeCompetitiveOpportunityNotional: createCounterSink(),
	indicativeCompetitiveCapturedNotional: createCounterSink(),
	indicativeFillVsQuoteOutcomeCount: createCounterSink(),
	indicativeTotalSizeOnBookGauge: createGaugeSink(),
	indicativeCompetitiveSizeOnBookGauge: createGaugeSink(),
});

describe('tradeMetricsProcessor', () => {
	it('processes a fill against multiple makers and records presence, competitiveness, and gauges', async () => {
		const published: Array<{ key: string; value: unknown }> = [];
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['good-maker', 'bad-maker']],
			[
				'mm_quotes_v2_perp_0_good-maker',
				{
					ts: 1710000000000,
					quotes: [
						{ bid_price: 100100000, bid_size: 2000000000 },
						{ ask_price: 99900000, ask_size: 2000000000 },
					],
				},
			],
			[
				'mm_quotes_v2_perp_0_bad-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 101000000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async (key, value) => {
					published.push({ key, value });
					return 1;
				},
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000000000,
		});

		const fillEvent: FillEvent = {
			ts: 1710000000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100.1,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			maker: 'maker-user-account',
			makerIndicativeKey: 'good-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			oraclePrice: 100,
			txSig: 'mock-1',
			slot: 1,
			fillRecordId: 1,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		};

		await processFillEvent(fillEvent);

		expect(published[0]?.key).toBe('dlob:trades_perp_0');
		expect(metrics.marketFillCount.calls).toHaveLength(1);

		expect(metrics.indicativePresenceCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
			{
				value: 1,
				attributes: {
					maker: 'bad-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
		]);

		expect(metrics.indicativeCompetitiveOpportunityCount.calls).toHaveLength(2);
		expect(metrics.indicativeCompetitiveFillCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
		]);

		expect(metrics.indicativeTotalSizeOnBookGauge.calls).toEqual(
			expect.arrayContaining([
				{
					value: 200.2,
					attributes: {
						maker: 'good-maker',
						market_index: 0,
						market_type: 'perp',
						side: 'long',
					},
				},
				{
					value: 101,
					attributes: {
						maker: 'bad-maker',
						market_index: 0,
						market_type: 'perp',
						side: 'long',
					},
				},
			])
		);

		expect(metrics.indicativeCompetitiveSizeOnBookGauge.calls).toEqual(
			expect.arrayContaining([
				{
					value: 200.2,
					attributes: {
						maker: 'good-maker',
						market_index: 0,
						market_type: 'perp',
						side: 'long',
					},
				},
				{
					value: 101,
					attributes: {
						maker: 'bad-maker',
						market_index: 0,
						market_type: 'perp',
						side: 'long',
					},
				},
			])
		);

		expect(metrics.indicativeFillVsQuoteOutcomeCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
					bucket: 'very_tight',
					direction: 'equal',
				},
			},
		]);
	});

	it('ignores fills from makers without indicative quotes', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['quoted-maker']],
			[
				'mm_quotes_v2_perp_0_quoted-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 99900000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000000000,
		});

		const fillEvent: FillEvent = {
			ts: 1710000000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100,
			maker: 'external-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100,
			oraclePrice: 100,
			txSig: 'mock-2',
			slot: 2,
			fillRecordId: 2,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		};

		await processFillEvent(fillEvent);

		expect(metrics.indicativeFillVsQuoteOutcomeCount.calls).toHaveLength(0);
	});

	it('does not emit fill-vs-quote outcomes when the mapped indicative maker had no fresh quote', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['quoted-maker']],
			[
				'mm_quotes_v2_perp_0_quoted-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 99900000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000005000,
		});

		await processFillEvent({
			ts: 1710000005,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100,
			maker: 'maker-user-account',
			makerIndicativeKey: 'quoted-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100,
			oraclePrice: 100,
			txSig: 'mock-no-quote',
			slot: 5,
			fillRecordId: 5,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		});

		expect(metrics.indicativeFillVsQuoteOutcomeCount.calls).toHaveLength(0);
	});

	it('does not count competitive fills when the mapped indicative maker is not competitive', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['quoted-maker']],
			[
				'mm_quotes_v2_perp_0_quoted-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 99900000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000000000,
		});

		const fillEvent: FillEvent = {
			ts: 1710000000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100,
			maker: 'maker-user-account',
			makerIndicativeKey: 'quoted-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100,
			oraclePrice: 100,
			txSig: 'mock-4',
			slot: 4,
			fillRecordId: 4,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		};

		await processFillEvent(fillEvent);

		expect(metrics.indicativeCompetitiveFillCount.calls).toHaveLength(0);
	});

	it('buckets fill-vs-quote for the mapped maker even when the quote was not competitive', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['quoted-maker']],
			[
				'mm_quotes_v2_perp_0_quoted-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 99900000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000000000,
		});

		await processFillEvent({
			ts: 1710000000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100,
			maker: 'maker-user-account',
			makerIndicativeKey: 'quoted-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100,
			oraclePrice: 100,
			txSig: 'mock-5',
			slot: 5,
			fillRecordId: 5,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		});

		expect(metrics.indicativeCompetitiveFillCount.calls).toHaveLength(0);
		expect(metrics.indicativeFillVsQuoteOutcomeCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'quoted-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
					bucket: 'tight',
					direction: 'better',
				},
			},
		]);
	});

	it('matches the latest quote at or before the fill timestamp', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['good-maker']],
			[
				'mm_quotes_v2_perp_0_good-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 100100000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 1,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000002500,
		});

		await processFillEvent({
			ts: 1710000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100.1,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			maker: 'good-maker',
			makerIndicativeKey: 'good-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			oraclePrice: 100,
			txSig: 'mock-3',
			slot: 3,
			fillRecordId: 3,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		});

		quoteState.set('mm_quotes_v2_perp_0_good-maker', {
			ts: 1710000002000,
			quotes: [{ bid_price: 100500000, bid_size: 1000000000 }],
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		await processFillEvent({
			ts: 1710000001,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100.1,
			taker: 'mock-taker',
			takerOrderId: 2,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			maker: 'good-maker',
			makerIndicativeKey: 'good-maker',
			makerOrderId: 3,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			oraclePrice: 100,
			txSig: 'mock-3b',
			slot: 4,
			fillRecordId: 4,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		});

		expect(metrics.indicativePresenceCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
		]);
		expect(metrics.indicativeFillVsQuoteOutcomeCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
					bucket: 'very_tight',
					direction: 'equal',
				},
			},
			{
				value: 1,
				attributes: {
					maker: 'good-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
					bucket: 'very_tight',
					direction: 'equal',
				},
			},
		]);
	});

	it('matches competitive fills using precomputed indicative key', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['indicative-maker']],
			[
				'mm_quotes_v2_perp_0_indicative-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 100100000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000000000,
		});

		const fillEvent: FillEvent = {
			ts: 1710000000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100.1,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			maker: 'maker-user-account',
			makerIndicativeKey: 'indicative-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			oraclePrice: 100,
			txSig: 'mock-5',
			slot: 5,
			fillRecordId: 5,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		};

		await processFillEvent(fillEvent);

		expect(metrics.indicativeCompetitiveFillCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'indicative-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
		]);
	});

	it('matches competitive fills using precomputed indicative key', async () => {
		const metrics = createMetricSinks();
		const quoteState = new Map<string, any>([
			['market_mms_perp_0', ['indicative-maker']],
			[
				'mm_quotes_v2_perp_0_indicative-maker',
				{
					ts: 1710000000000,
					quotes: [{ bid_price: 100100000, bid_size: 1000000000 }],
				},
			],
		]);

		const { processFillEvent } = createTradeMetricsProcessor({
			redisClientPrefix: 'dlob:',
			indicativeQuoteMaxAgeMs: 1000,
			indicativeQuotesCacheTtlMs: 250,
			spotMarketPrecisionResolver: () => undefined,
			publisherRedisClient: {
				publish: async () => 1,
			},
			indicativeQuotesRedisClient: {
				smembers: async (key) => quoteState.get(key) ?? [],
				get: async (key) => quoteState.get(key),
			},
			metrics,
			nowMsProvider: () => 1710000000000,
		});

		const fillEvent: FillEvent = {
			ts: 1710000000000,
			marketIndex: 0,
			marketType: 'perp',
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100.1,
			taker: 'mock-taker',
			takerOrderId: 1,
			takerOrderDirection: 'short',
			takerOrderBaseAssetAmount: 1,
			takerOrderCumulativeBaseAssetAmountFilled: 1,
			takerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			maker: 'maker-user-account',
			makerIndicativeKey: 'indicative-maker',
			makerOrderId: 2,
			makerOrderDirection: 'long',
			makerOrderBaseAssetAmount: 1,
			makerOrderCumulativeBaseAssetAmountFilled: 1,
			makerOrderCumulativeQuoteAssetAmountFilled: 100.1,
			oraclePrice: 100,
			txSig: 'mock-5',
			slot: 5,
			fillRecordId: 5,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		};

		await processFillEvent(fillEvent);

		expect(metrics.indicativeCompetitiveFillCount.calls).toEqual([
			{
				value: 1,
				attributes: {
					maker: 'indicative-maker',
					market_index: 0,
					market_type: 'perp',
					side: 'long',
				},
			},
		]);
	});
});
