import { describe, expect, it } from '@jest/globals';
import { BASE_PRECISION, PRICE_PRECISION } from '@velocity-exchange/sdk';
import {
	getAbsoluteBpsDiff,
	getCompetitiveLiquidity,
	getIndicativeDirectionBucket,
	getFillPrice,
	getFillSide,
	getFillTimestampMs,
	getIndicativeBpsBucket,
	getQuotedFillReferencePrice,
	getQuoteTimestampMs,
	getQuoteValueOnBook,
	getSignedBpsDiff,
	isCompetitivePrice,
	rawPriceToNumber,
} from '../tradeMetrics';

describe('tradeMetrics', () => {
	describe('getFillPrice', () => {
		it('computes the executed unit price', () => {
			expect(
				getFillPrice({
					baseAssetAmountFilled: 2,
					quoteAssetAmountFilled: 210,
				})
			).toBe(105);
		});

		it('returns undefined for zero base size', () => {
			expect(
				getFillPrice({
					baseAssetAmountFilled: 0,
					quoteAssetAmountFilled: 210,
				})
			).toBeUndefined();
		});
	});

	describe('getFillTimestampMs', () => {
		it('normalizes seconds to milliseconds', () => {
			expect(getFillTimestampMs(1710000000)).toBe(1710000000000);
		});

		it('leaves millisecond timestamps unchanged', () => {
			expect(getFillTimestampMs(1710000000000)).toBe(1710000000000);
		});
	});

	describe('getQuoteTimestampMs', () => {
		it('extracts the quote timestamp when present', () => {
			expect(getQuoteTimestampMs({ ts: 1710000000000 })).toBe(1710000000000);
		});

		it('returns undefined for missing or invalid timestamps', () => {
			expect(getQuoteTimestampMs(null)).toBeUndefined();
			expect(getQuoteTimestampMs({ ts: 'bad-ts' })).toBeUndefined();
		});
	});

	describe('getFillSide', () => {
		it('infers the maker side from taker direction first', () => {
			expect(getFillSide({ takerOrderDirection: 'long' })).toBe('short');
			expect(getFillSide({ takerOrderDirection: 'short' })).toBe('long');
		});

		it('falls back to maker direction', () => {
			expect(getFillSide({ makerOrderDirection: 'long' })).toBe('long');
			expect(getFillSide({ makerOrderDirection: 'short' })).toBe('short');
		});

		it('returns undefined when neither side is available', () => {
			expect(getFillSide({})).toBeUndefined();
		});
	});

	describe('rawPriceToNumber', () => {
		it('converts oracle-offset quotes to absolute prices', () => {
			expect(rawPriceToNumber(2 * PRICE_PRECISION.toNumber(), 100)).toBe(102);
		});
	});

	describe('isCompetitivePrice', () => {
		it('treats bid prices at or above the fill price as competitive', () => {
			expect(isCompetitivePrice('long', 101, 100)).toBe(true);
			expect(isCompetitivePrice('long', 99, 100)).toBe(false);
		});

		it('treats ask prices at or below the fill price as competitive', () => {
			expect(isCompetitivePrice('short', 99, 100)).toBe(true);
			expect(isCompetitivePrice('short', 101, 100)).toBe(false);
		});
	});

	describe('bps bucketing', () => {
		it('computes absolute bps distance', () => {
			expect(getAbsoluteBpsDiff(100.1, 100)).toBeCloseTo(10, 8);
			expect(getAbsoluteBpsDiff(99.9, 100)).toBeCloseTo(10, 8);
		});

		it('computes signed bps distance', () => {
			expect(getSignedBpsDiff(100.1, 100)).toBeCloseTo(10, 8);
			expect(getSignedBpsDiff(99.9, 100)).toBeCloseTo(-10, 8);
		});

		it('maps bps distances into the configured buckets', () => {
			expect(getIndicativeBpsBucket(0)).toBe('very_tight');
			expect(getIndicativeBpsBucket(9.99)).toBe('very_tight');
			expect(getIndicativeBpsBucket(10)).toBe('tight');
			expect(getIndicativeBpsBucket(19.99)).toBe('tight');
			expect(getIndicativeBpsBucket(20)).toBe('moderate');
			expect(getIndicativeBpsBucket(29.99)).toBe('moderate');
			expect(getIndicativeBpsBucket(30)).toBe('wide');
			expect(getIndicativeBpsBucket(49.99)).toBe('wide');
			expect(getIndicativeBpsBucket(50)).toBe('very_wide');
			expect(getIndicativeBpsBucket(500)).toBe('very_wide');
		});

		it('maps signed bps distances into directional buckets', () => {
			expect(getIndicativeDirectionBucket(10)).toBe('better');
			expect(getIndicativeDirectionBucket(0)).toBe('equal');
			expect(getIndicativeDirectionBucket(-10)).toBe('worse');
		});
	});

	describe('getCompetitiveLiquidity', () => {
		it('aggregates only bid levels that were competitive for a long maker', () => {
			const liquidity = getCompetitiveLiquidity(
				'mm-1',
				{
					marketIndex: 0,
					marketType: 'perp',
					oraclePrice: 100,
				},
				'long',
				100,
				{
					ts: 1710000000000,
					quotes: [
						{
							bid_price: 101 * PRICE_PRECISION.toNumber(),
							bid_size: BASE_PRECISION.toNumber(),
						},
						{
							bid_price: 100 * PRICE_PRECISION.toNumber(),
							bid_size: 2 * BASE_PRECISION.toNumber(),
						},
						{
							bid_price: 99 * PRICE_PRECISION.toNumber(),
							bid_size: 4 * BASE_PRECISION.toNumber(),
						},
					],
				}
			);

			expect(liquidity).toEqual({
				maker: 'mm-1',
				bestPrice: 101,
				size: 3,
				quoteValue: 301,
				quoteTsMs: 1710000000000,
			});
		});

		it('aggregates only ask levels that were competitive for a short maker', () => {
			const liquidity = getCompetitiveLiquidity(
				'mm-2',
				{
					marketIndex: 0,
					marketType: 'perp',
					oraclePrice: 100,
				},
				'short',
				100,
				{
					ts: 1710000000000,
					quotes: [
						{
							ask_price: 99 * PRICE_PRECISION.toNumber(),
							ask_size: 1.5 * BASE_PRECISION.toNumber(),
						},
						{
							ask_price: 100 * PRICE_PRECISION.toNumber(),
							ask_size: 0.5 * BASE_PRECISION.toNumber(),
						},
						{
							ask_price: 101 * PRICE_PRECISION.toNumber(),
							ask_size: 10 * BASE_PRECISION.toNumber(),
						},
					],
				}
			);

			expect(liquidity).toEqual({
				maker: 'mm-2',
				bestPrice: 99,
				size: 2,
				quoteValue: 198.5,
				quoteTsMs: 1710000000000,
			});
		});

		it('supports oracle-offset quotes', () => {
			const liquidity = getCompetitiveLiquidity(
				'mm-3',
				{
					marketIndex: 0,
					marketType: 'perp',
					oraclePrice: 100,
				},
				'long',
				100,
				{
					ts: 1710000000000,
					quotes: [
						{
							bid_price: PRICE_PRECISION.toNumber(),
							bid_size: BASE_PRECISION.toNumber(),
							is_oracle_offset: true,
						},
					],
				}
			);

			expect(liquidity?.bestPrice).toBe(101);
			expect(liquidity?.size).toBe(1);
		});

		it('uses spot market precision when provided', () => {
			const liquidity = getCompetitiveLiquidity(
				'mm-4',
				{
					marketIndex: 1,
					marketType: 'spot',
					oraclePrice: 10,
				},
				'long',
				10,
				{
					ts: 1710000000000,
					quotes: [
						{
							bid_price: 10 * PRICE_PRECISION.toNumber(),
							bid_size: 2_000_000,
						},
					],
				},
				1_000_000
			);

			expect(liquidity?.size).toBe(2);
		});

		it('returns undefined when no levels were competitive', () => {
			expect(
				getCompetitiveLiquidity(
					'mm-5',
					{
						marketIndex: 0,
						marketType: 'perp',
						oraclePrice: 100,
					},
					'long',
					100,
					{
						ts: 1710000000000,
						quotes: [
							{
								bid_price: 99 * PRICE_PRECISION.toNumber(),
								bid_size: BASE_PRECISION.toNumber(),
							},
						],
					}
				)
			).toBeUndefined();
		});
	});

	describe('getQuotedFillReferencePrice', () => {
		it('uses a size-weighted price capped by the fill size for long-side quotes', () => {
			const referencePrice = getQuotedFillReferencePrice(
				{
					marketIndex: 0,
					marketType: 'perp',
					oraclePrice: 100,
				},
				'long',
				1.5,
				{
					ts: 1710000000000,
					quotes: [
						{
							bid_price: 101 * PRICE_PRECISION.toNumber(),
							bid_size: BASE_PRECISION.toNumber(),
						},
						{
							bid_price: 100 * PRICE_PRECISION.toNumber(),
							bid_size: 2 * BASE_PRECISION.toNumber(),
						},
					],
				}
			);

			expect(referencePrice).toBeCloseTo(100.6666666667, 8);
		});

		it('uses the full quoted ladder when the fill is larger than the top level', () => {
			const referencePrice = getQuotedFillReferencePrice(
				{
					marketIndex: 0,
					marketType: 'perp',
					oraclePrice: 100,
				},
				'short',
				1.5,
				{
					ts: 1710000000000,
					quotes: [
						{
							ask_price: 99 * PRICE_PRECISION.toNumber(),
							ask_size: 1 * BASE_PRECISION.toNumber(),
						},
						{
							ask_price: 100 * PRICE_PRECISION.toNumber(),
							ask_size: 1 * BASE_PRECISION.toNumber(),
						},
					],
				}
			);

			expect(referencePrice).toBeCloseTo(99.3333333333, 8);
		});
	});

	describe('getQuoteValueOnBook', () => {
		it('sums quote notional on the relevant side', () => {
			expect(
				getQuoteValueOnBook(
					{
						marketIndex: 0,
						marketType: 'perp',
						oraclePrice: 100,
					},
					'long',
					{
						ts: 1710000000000,
						quotes: [
							{
								bid_price: 101 * PRICE_PRECISION.toNumber(),
								bid_size: BASE_PRECISION.toNumber(),
							},
							{
								bid_price: 100 * PRICE_PRECISION.toNumber(),
								bid_size: 2 * BASE_PRECISION.toNumber(),
							},
						],
					}
				)
			).toBe(301);
		});

		it('supports oracle offset prices', () => {
			expect(
				getQuoteValueOnBook(
					{
						marketIndex: 0,
						marketType: 'perp',
						oraclePrice: 100,
					},
					'long',
					{
						ts: 1710000000000,
						quotes: [
							{
								bid_price: PRICE_PRECISION.toNumber(),
								bid_size: BASE_PRECISION.toNumber(),
								is_oracle_offset: true,
							},
						],
					}
				)
			).toBe(101);
		});
	});
});
