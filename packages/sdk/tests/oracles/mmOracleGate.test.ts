import * as _ from 'lodash';
import {
	BN,
	OracleGuardRails,
	OracleValidity,
	PRICE_PRECISION,
	getOracleValidity,
	isOracleTooDivergent,
	isFallbackAvailableLiquiditySource,
	MMOraclePriceData,
	StateAccount,
	VelocityClient,
} from '../../src';
import { mockPerpMarkets } from '../dlob/helpers';
import { mockOrder } from '../user/helpers';
import { assert } from '../../src/assert/assert';

// Pins the UseMMOraclePrice gating semantics from
// `programs/velocity/src/state/perp_market.rs::get_mm_oracle_price_data`: the
// fallback to the exchange oracle is driven by `is_oracle_valid_for_action`
// (NonPositive/TooVolatile only), never by the twap-5min divergence band that
// `isOracleTooDivergent` mirrors elsewhere (`validate_fill_price_within_price_bands`).
describe('MM oracle validity gate (UseMMOraclePrice semantics)', () => {
	it('does not fall back to the exchange oracle solely because mm price diverged from a stale 5min twap', () => {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		market.marketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			100
		).mul(PRICE_PRECISION);
		market.marketStats.historicalOracleData.lastOraclePriceTwap5Min = new BN(
			100
		).mul(PRICE_PRECISION);

		// Market has moved a long way from the stale 5min twap, but the mm
		// oracle and the current exchange oracle agree closely with each other.
		const exchangeOraclePrice = new BN(160).mul(PRICE_PRECISION);
		const mmOraclePrice = new BN(161).mul(PRICE_PRECISION);
		const mmOracleSlot = new BN(1000);
		const mmOracleConfidence = new BN(1000);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(0),
				oracleTwap5MinPercentDivergence: new BN(0),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(10),
				slotsBeforeStaleForMargin: new BN(60),
				confidenceIntervalMaxSize: new BN(20000),
				tooVolatileRatio: new BN(5),
			},
		};

		// Old (incorrect) gate: mirrors validate_fill_price_within_price_bands,
		// which is NOT what the program checks before using the mm oracle price.
		const wasTooDivergentUnderOldGate = isOracleTooDivergent(
			market.marketStats,
			{
				price: mmOraclePrice,
				slot: mmOracleSlot,
				confidence: mmOracleConfidence,
				hasSufficientNumberOfDataPoints: true,
			},
			oracleGuardRails
		);
		assert(
			wasTooDivergentUnderOldGate,
			'expected the twap5min-divergence check to trip on the stale twap'
		);

		// Correct gate: is_oracle_valid_for_action(mm_oracle_validity, UseMMOraclePrice)
		// only rejects NonPositive/TooVolatile.
		const mmOracleValidity = getOracleValidity(
			market,
			{
				price: mmOraclePrice,
				slot: mmOracleSlot,
				confidence: mmOracleConfidence,
				hasSufficientNumberOfDataPoints: true,
			},
			oracleGuardRails,
			mmOracleSlot
		);
		const isMMOracleInvalidForUse =
			mmOracleValidity === OracleValidity.NonPositive ||
			mmOracleValidity === OracleValidity.TooVolatile;

		assert(
			!isMMOracleInvalidForUse,
			`expected mm oracle to remain valid for UseMMOraclePrice, got validity=${OracleValidity[mmOracleValidity]}`
		);

		// Sanity: the exchange oracle is not materially different from the mm
		// oracle, so the 1% mm-vs-exchange fallback threshold used alongside this
		// gate would not itself trigger a fallback either.
		const pctDiff = mmOraclePrice
			.sub(exchangeOraclePrice)
			.abs()
			.mul(new BN(1_000_000))
			.div(exchangeOraclePrice);
		assert(pctDiff.lt(new BN(10_000)), 'expected mm/exchange prices within 1%');
	});

	it('does fall back when the mm oracle itself is too volatile vs its own twap', () => {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		market.marketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			100
		).mul(PRICE_PRECISION);
		market.marketStats.historicalOracleData.lastOraclePriceTwap5Min = new BN(
			100
		).mul(PRICE_PRECISION);

		const mmOraclePrice = new BN(600).mul(PRICE_PRECISION); // 6x the twap
		const mmOracleSlot = new BN(1000);
		const mmOracleConfidence = new BN(1000);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(0),
				oracleTwap5MinPercentDivergence: new BN(0),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(10),
				slotsBeforeStaleForMargin: new BN(60),
				confidenceIntervalMaxSize: new BN(20000),
				tooVolatileRatio: new BN(5),
			},
		};

		const mmOracleValidity = getOracleValidity(
			market,
			{
				price: mmOraclePrice,
				slot: mmOracleSlot,
				confidence: mmOracleConfidence,
				hasSufficientNumberOfDataPoints: true,
			},
			oracleGuardRails,
			mmOracleSlot
		);

		assert(mmOracleValidity === OracleValidity.TooVolatile);
	});
});

// Pins the sequence-id recency ordering in
// `VelocityClient.getMMOracleDataForPerpMarket` against the program's
// `MMOraclePriceData::new` (`state/oracle.rs`). Two boundary cases the SDK
// previously got wrong:
//   1. Equal sequence ids: Rust uses `exchange_seq > mm_seq`, so equal ids mean
//      the exchange oracle is NOT more recent and the MM price is used.
//   2. The sequence-id path guard is `abs_diff < exchange_seq / 10_000`; the slot
//      path is its negation and must fire on `>=`, not `>`.
describe('MM oracle sequence-id recency (getMMOracleDataForPerpMarket)', () => {
	const guardRails: OracleGuardRails = {
		priceDivergence: {
			markOraclePercentDivergence: new BN(0),
			oracleTwap5MinPercentDivergence: new BN(0),
		},
		validity: {
			slotsBeforeStaleForAmm: new BN(10),
			slotsBeforeStaleForMargin: new BN(60),
			confidenceIntervalMaxSize: new BN(20000),
			tooVolatileRatio: new BN(5),
		},
	};

	// exchange 100.0, mm 100.5 => 0.5% apart (within the 1% fallback threshold),
	// so the only thing deciding which price is returned is the recency ordering.
	const exchangePrice = new BN(100).mul(PRICE_PRECISION);
	const mmOraclePrice = exchangePrice.add(PRICE_PRECISION.divn(2));

	function callWith(
		exchangeSequenceId: BN,
		mmOracleSequenceId: BN
	): MMOraclePriceData {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		// twaps == exchange price keeps the mm oracle Valid (not TooVolatile).
		market.marketStats.historicalOracleData.lastOraclePriceTwap = exchangePrice;
		market.marketStats.historicalOracleData.lastOraclePriceTwap5Min =
			exchangePrice;
		market.marketStats.mmOraclePrice = mmOraclePrice;
		market.marketStats.mmOracleSlot = new BN(1000);
		market.marketStats.mmOracleSequenceId = mmOracleSequenceId;

		const oracleData = {
			price: exchangePrice,
			slot: new BN(1000),
			confidence: new BN(1000),
			hasSufficientNumberOfDataPoints: true,
			sequenceId: exchangeSequenceId,
		};

		const fakeThis = {
			getPerpMarketAccountOrThrow: () => market,
			getOracleDataForPerpMarket: () => oracleData,
			accountSubscriber: {
				getStateAccountAndSlot: () => ({
					data: { oracleGuardRails: guardRails },
					slot: 1000,
				}),
			},
		};

		return VelocityClient.prototype.getMMOracleDataForPerpMarket.call(
			fakeThis,
			0
		) as MMOraclePriceData;
	}

	it('uses the MM oracle when sequence ids are equal (mirrors exchange_seq > mm_seq)', () => {
		// seq >= 10_000 so abs_diff(0) < seq/10_000, i.e. the sequence-id path is taken.
		const result = callWith(new BN(20000), new BN(20000));
		assert(
			result.price.eq(mmOraclePrice),
			`expected MM price on equal sequence ids, got ${result.price.toString()}`
		);
	});

	it('uses the MM oracle when the exchange sequence id is older', () => {
		// abs_diff (5) < threshold (100_000 / 10_000 = 10) => sequence-id path.
		const result = callWith(new BN(100_000), new BN(100_005));
		assert(
			result.price.eq(mmOraclePrice),
			`expected MM price when exchange seq < mm seq, got ${result.price.toString()}`
		);
	});

	it('falls back to the exchange oracle when its sequence id is newer', () => {
		// abs_diff (6) < threshold (100_006 / 10_000 = 10) => sequence-id path.
		const result = callWith(new BN(100_006), new BN(100_000));
		assert(
			result.price.eq(exchangePrice),
			`expected exchange price when exchange seq > mm seq, got ${result.price.toString()}`
		);
	});

	it('switches to slot recency at the abs_diff == seq/10_000 boundary (>=, not >)', () => {
		// exchange_seq = 100_000 => threshold = 10. abs_diff = 10 == threshold, so
		// Rust takes the slot/delay path. With equal slots the exchange oracle is not
		// more recent, so the MM price is used — a `>` guard would instead take the
		// sequence path and, with exchange_seq (100_010) > mm_seq (100_000), wrongly
		// fall back to the exchange oracle.
		const result = callWith(new BN(100_010), new BN(100_000));
		assert(
			result.price.eq(mmOraclePrice),
			`expected MM price at the slot-path boundary, got ${result.price.toString()}`
		);
	});
});

// M15: isFallbackAvailableLiquiditySource must mirror amm_fill_gates_ok's
// mm_oracle_not_too_volatile gate: suppress AMM fills when the MM oracle is
// enabled, at least as recent as the exchange oracle, and diverges >1% from it.
describe('AMM fallback availability — MM-oracle volatility gate', () => {
	const guardRails: OracleGuardRails = {
		priceDivergence: {
			markOraclePercentDivergence: new BN(0),
			oracleTwap5MinPercentDivergence: new BN(0),
		},
		validity: {
			slotsBeforeStaleForAmm: new BN(10),
			slotsBeforeStaleForMargin: new BN(60),
			confidenceIntervalMaxSize: new BN(20000),
			tooVolatileRatio: new BN(5),
		},
	};

	const slot = 1000;

	function makeValidMarketAndState() {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		market.pausedOperations = 0;
		market.marketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			100
		).mul(PRICE_PRECISION);
		market.marketStats.historicalOracleData.lastOraclePriceTwap5Min = new BN(
			100
		).mul(PRICE_PRECISION);
		const state = { oracleGuardRails: guardRails } as StateAccount;
		return { market, state };
	}

	// A fresh, on-price MM oracle => OracleValidity.Valid, so the only thing that
	// can flip availability in these cases is the volatility gate.
	function makeMMData(
		overrides: Partial<MMOraclePriceData>
	): MMOraclePriceData {
		return {
			price: new BN(100).mul(PRICE_PRECISION),
			slot: new BN(slot),
			confidence: new BN(1000),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
			isMMOracleEnabled: true,
			isMMOracleAsRecent: true,
			isMMExchangeDiffBpsHigh: false,
			...overrides,
		};
	}

	it('is available (baseline) when the mm oracle is valid and diff is within 1%', () => {
		const { market, state } = makeValidMarketAndState();
		const available = isFallbackAvailableLiquiditySource(
			mockOrder,
			makeMMData({}),
			slot,
			state,
			market
		);
		assert(
			available,
			'expected AMM fallback available for a valid, low-diff mm oracle'
		);
	});

	it('is blocked when mm oracle is enabled, as-recent, and diff > 1%', () => {
		const { market, state } = makeValidMarketAndState();
		const available = isFallbackAvailableLiquiditySource(
			mockOrder,
			makeMMData({ isMMExchangeDiffBpsHigh: true }),
			slot,
			state,
			market
		);
		assert(
			!available,
			'expected AMM fallback blocked by mm-oracle volatility gate'
		);
	});

	it('is NOT blocked by the volatility gate when the mm oracle is not as-recent (mirrors else{true})', () => {
		const { market, state } = makeValidMarketAndState();
		const available = isFallbackAvailableLiquiditySource(
			mockOrder,
			makeMMData({ isMMExchangeDiffBpsHigh: true, isMMOracleAsRecent: false }),
			slot,
			state,
			market
		);
		assert(
			available,
			'expected volatility gate to not apply when mm oracle is stale'
		);
	});

	it('is NOT blocked by the volatility gate when the mm oracle is disabled', () => {
		const { market, state } = makeValidMarketAndState();
		const available = isFallbackAvailableLiquiditySource(
			mockOrder,
			makeMMData({ isMMExchangeDiffBpsHigh: true, isMMOracleEnabled: false }),
			slot,
			state,
			market
		);
		assert(
			available,
			'expected volatility gate to not apply when mm oracle disabled'
		);
	});

	it('skips the volatility gate when the flags are absent (backward compat)', () => {
		const { market, state } = makeValidMarketAndState();
		const available = isFallbackAvailableLiquiditySource(
			mockOrder,
			makeMMData({
				isMMOracleEnabled: undefined,
				isMMOracleAsRecent: undefined,
				isMMExchangeDiffBpsHigh: undefined,
			}),
			slot,
			state,
			market
		);
		assert(
			available,
			'expected gate skipped when mm volatility flags unpopulated'
		);
	});
});
