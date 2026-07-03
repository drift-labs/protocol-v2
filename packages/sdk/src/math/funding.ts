import { BN } from '../isomorphic/anchor';
import {
	AMM_RESERVE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
	ONE,
	FUNDING_RATE_OFFSET_DENOMINATOR,
	BPS_PRECISION,
	PERCENTAGE_PRECISION,
} from '../constants/numericConstants';
import { BigNum } from '../factory/bigNum';
import { PerpMarketAccount, isVariant } from '../types';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import { calculateBidAskPrice } from './amm';
import { calculateLiveOracleTwap } from './oracles';
import { clampBN } from './utils';
import {
	FUNDING_RATE_BUFFER_PRECISION,
	FUNDING_RATE_PRECISION_EXP,
} from '../constants/numericConstants';

function calculateLiveMarkTwap(
	market: PerpMarketAccount,
	mmOraclePriceData?: MMOraclePriceData,
	markPrice?: BN,
	now?: BN,
	period = new BN(3600)
): BN {
	now = now || new BN((Date.now() / 1000).toFixed(0));

	const lastMarkTwapWithMantissa = market.marketStats.lastMarkPriceTwap;
	const lastMarkPriceTwapTs = market.marketStats.lastMarkPriceTwapTs;

	const timeSinceLastMarkChange = now.sub(lastMarkPriceTwapTs);
	const markTwapTimeSinceLastUpdate = BN.max(
		period,
		BN.max(ZERO, period.sub(timeSinceLastMarkChange))
	);

	if (!markPrice) {
		const [bid, ask] = calculateBidAskPrice(
			market.amm,
			market.marketStats,
			mmOraclePriceData
		);
		markPrice = bid.add(ask).div(new BN(2));
	}

	const markTwapWithMantissa = markTwapTimeSinceLastUpdate
		.mul(lastMarkTwapWithMantissa)
		.add(timeSinceLastMarkChange.mul(markPrice))
		.div(timeSinceLastMarkChange.add(markTwapTimeSinceLastUpdate));

	return markTwapWithMantissa;
}

function shrinkStaleTwaps(
	market: PerpMarketAccount,
	markTwapWithMantissa: BN,
	oracleTwapWithMantissa: BN,
	now?: BN
) {
	now = now || new BN((Date.now() / 1000).toFixed(0));
	let newMarkTwap = markTwapWithMantissa;
	let newOracleTwap = oracleTwapWithMantissa;
	if (
		market.marketStats.lastMarkPriceTwapTs.gt(
			market.marketStats.historicalOracleData.lastOraclePriceTwapTs
		)
	) {
		// shrink oracle based on invalid intervals
		const oracleInvalidDuration = BN.max(
			ZERO,
			market.marketStats.lastMarkPriceTwapTs.sub(
				market.marketStats.historicalOracleData.lastOraclePriceTwapTs
			)
		);
		const timeSinceLastOracleTwapUpdate = now.sub(
			market.marketStats.historicalOracleData.lastOraclePriceTwapTs
		);
		const oracleTwapTimeSinceLastUpdate = BN.max(
			ONE,
			BN.min(
				market.marketStats.fundingPeriod,
				BN.max(
					ONE,
					market.marketStats.fundingPeriod.sub(timeSinceLastOracleTwapUpdate)
				)
			)
		);
		newOracleTwap = oracleTwapTimeSinceLastUpdate
			.mul(oracleTwapWithMantissa)
			.add(oracleInvalidDuration.mul(markTwapWithMantissa))
			.div(oracleTwapTimeSinceLastUpdate.add(oracleInvalidDuration));
	} else if (
		market.marketStats.lastMarkPriceTwapTs.lt(
			market.marketStats.historicalOracleData.lastOraclePriceTwapTs
		)
	) {
		// shrink mark to oracle twap over tradless intervals
		const tradelessDuration = BN.max(
			ZERO,
			market.marketStats.historicalOracleData.lastOraclePriceTwapTs.sub(
				market.marketStats.lastMarkPriceTwapTs
			)
		);
		const timeSinceLastMarkTwapUpdate = now.sub(
			market.marketStats.lastMarkPriceTwapTs
		);
		const markTwapTimeSinceLastUpdate = BN.max(
			ONE,
			BN.min(
				market.marketStats.fundingPeriod,
				BN.max(
					ONE,
					market.marketStats.fundingPeriod.sub(timeSinceLastMarkTwapUpdate)
				)
			)
		);
		newMarkTwap = markTwapTimeSinceLastUpdate
			.mul(markTwapWithMantissa)
			.add(tradelessDuration.mul(oracleTwapWithMantissa))
			.div(markTwapTimeSinceLastUpdate.add(tradelessDuration));
	}

	return [newMarkTwap, newOracleTwap];
}

/**
 * Client-side projection of the market's next funding rate, mirroring the pure-math portion
 * of `update_funding_rate` in `programs/velocity/src/controller/funding.rs` (live mark/oracle
 * TWAPs, the per-market dead-zone/ramp-slope premium, the baseline
 * `FUNDING_RATE_OFFSET_DENOMINATOR` offset, and the contract-tier divergence cap) without
 * requiring an on-chain funding update to have actually run. This is an estimate for display
 * or pre-trade planning — it does not settle anything and can differ slightly from what the
 * next on-chain `update_funding_rate` call computes if `now`/`oraclePriceData` have moved
 * since.
 * @param market Perp market to estimate funding for; must not be `uninitialized`.
 * @param mmOraclePriceData Current MM oracle price data, used to compute the live mark TWAP if `markPrice` isn't supplied.
 * @param oraclePriceData Current oracle price data — required unless the market is uninitialized.
 * @param markPrice Optional mark price override; if omitted, derived from the current bid/ask midpoint.
 * @param now Current unix timestamp (seconds); defaults to wall-clock time.
 * @returns `[markTwap, oracleTwap, lowerboundEst, cappedAltEst, interpEst]`:
 *   - `markTwap` / `oracleTwap`: live-projected TWAPs, PRICE_PRECISION (1e6).
 *   - `lowerboundEst`, `cappedAltEst`, `interpEst`: funding-rate-per-period estimates
 *     expressed as `(price spread / oracle price) * 1e8` — feed these into
 *     `getFundingRatePct`/`calculateFormattedLiveFundingRate` (which multiply by
 *     `FUNDING_RATE_BUFFER_PRECISION` and read the result at `FUNDING_RATE_PRECISION_EXP`,
 *     1e9) to get a plain percentage. `cappedAltEst` is the smaller-open-interest side,
 *     capped by how much the fee pool can top it up; `interpEst` is the uncapped
 *     straight-line interpolation; `lowerboundEst` further scales the spread down by the
 *     fraction of the current funding period that has elapsed since the last update.
 */
export function calculateAllEstimatedFundingRate(
	market: PerpMarketAccount,
	mmOraclePriceData?: MMOraclePriceData,
	oraclePriceData?: OraclePriceData,
	markPrice?: BN,
	now?: BN
): [BN, BN, BN, BN, BN] {
	if (isVariant(market.status, 'uninitialized')) {
		return [ZERO, ZERO, ZERO, ZERO, ZERO];
	}

	// todo: sufficiently differs from blockchain timestamp?
	now = now || new BN((Date.now() / 1000).toFixed(0));

	// calculate real-time mark and oracle twap
	const liveMarkTwap = calculateLiveMarkTwap(
		market,
		mmOraclePriceData,
		markPrice,
		now,
		market.marketStats.fundingPeriod
	);
	if (!oraclePriceData) {
		throw new Error(
			'calculateAllEstimatedFundingRate: oraclePriceData is required for an initialized market'
		);
	}
	const liveOracleTwap = calculateLiveOracleTwap(
		market.marketStats.historicalOracleData,
		oraclePriceData,
		now,
		market.marketStats.fundingPeriod
	);
	const [markTwap, oracleTwap] = shrinkStaleTwaps(
		market,
		liveMarkTwap,
		liveOracleTwap,
		now
	);

	// if(!markTwap.eq(liveMarkTwap)){
	// 	console.log('shrink mark:', liveMarkTwap.toString(), '->', markTwap.toString());
	// }

	// if(!oracleTwap.eq(liveOracleTwap)){
	// 	console.log('shrink orac:', liveOracleTwap.toString(), '->', oracleTwap.toString());
	// }

	const twapSpread = markTwap.sub(oracleTwap);
	const offset = oracleTwap.abs().div(FUNDING_RATE_OFFSET_DENOMINATOR);

	// dead-zone threshold (per-market bps) as a price delta off the oracle twap
	const clampThreshold = oracleTwap
		.abs()
		.mul(new BN(market.fundingClampThreshold))
		.div(BPS_PRECISION);

	let twapSpreadWithOffset: BN;
	if (twapSpread.abs().lte(clampThreshold)) {
		// inside the band: noise, no premium, baseline offset only
		twapSpreadWithOffset = offset;
	} else {
		// outside the band: shrink the spread toward zero by the band width
		// (keeping its sign), scale by the per-market ramp slope, add the offset
		const shrunk = twapSpread.isNeg()
			? twapSpread.add(clampThreshold)
			: twapSpread.sub(clampThreshold);
		const ramped = shrunk
			.mul(new BN(market.fundingRampSlope))
			.div(PERCENTAGE_PRECISION);
		twapSpreadWithOffset = ramped.add(offset);
	}

	const maxSpread = getMaxPriceDivergenceForFundingRate(market, oracleTwap);

	const clampedSpreadWithOffset = clampBN(
		twapSpreadWithOffset,
		maxSpread.mul(new BN(-1)),
		maxSpread
	);

	const twapSpreadPct = clampedSpreadWithOffset
		.mul(PRICE_PRECISION)
		.mul(new BN(100))
		.div(oracleTwap);

	const secondsInHour = new BN(3600);
	const hoursInDay = new BN(24);
	const timeSinceLastUpdate = now.sub(market.lastFundingRateTs);

	const lowerboundEst = twapSpreadPct
		.mul(market.marketStats.fundingPeriod)
		.mul(BN.min(secondsInHour, timeSinceLastUpdate))
		.div(secondsInHour)
		.div(secondsInHour)
		.div(hoursInDay);

	const interpEst = twapSpreadPct.div(hoursInDay);

	const interpRateQuote = twapSpreadPct
		.div(hoursInDay)
		.div(PRICE_PRECISION.div(QUOTE_PRECISION));

	let feePoolSize = calculateFundingPool(market);
	if (interpRateQuote.lt(new BN(0))) {
		feePoolSize = feePoolSize.mul(new BN(-1));
	}

	let cappedAltEst: BN;
	let largerSide: BN;
	let smallerSide: BN;
	if (market.baseAssetAmountLong.gt(market.baseAssetAmountShort.abs())) {
		largerSide = market.baseAssetAmountLong.abs();
		smallerSide = market.baseAssetAmountShort.abs();
		if (twapSpread.gt(new BN(0))) {
			return [markTwap, oracleTwap, lowerboundEst, interpEst, interpEst];
		}
	} else if (market.baseAssetAmountLong.lt(market.baseAssetAmountShort.abs())) {
		largerSide = market.baseAssetAmountShort.abs();
		smallerSide = market.baseAssetAmountLong.abs();
		if (twapSpread.lt(new BN(0))) {
			return [markTwap, oracleTwap, lowerboundEst, interpEst, interpEst];
		}
	} else {
		return [markTwap, oracleTwap, lowerboundEst, interpEst, interpEst];
	}

	if (largerSide.gt(ZERO)) {
		// funding smaller flow
		cappedAltEst = smallerSide.mul(twapSpread).div(hoursInDay);
		const feePoolTopOff = feePoolSize
			.mul(PRICE_PRECISION.div(QUOTE_PRECISION))
			.mul(AMM_RESERVE_PRECISION);
		cappedAltEst = cappedAltEst.add(feePoolTopOff).div(largerSide);

		cappedAltEst = cappedAltEst
			.mul(PRICE_PRECISION)
			.mul(new BN(100))
			.div(oracleTwap);

		if (cappedAltEst.abs().gte(interpEst.abs())) {
			cappedAltEst = interpEst;
		}
	} else {
		cappedAltEst = interpEst;
	}

	return [markTwap, oracleTwap, lowerboundEst, cappedAltEst, interpEst];
}

/**
 * Converts a raw funding-rate estimate (as produced by `calculateAllEstimatedFundingRate`,
 * scaled as `(price spread / oracle price) * 1e8`) into a plain human-readable percentage
 * number (e.g. `0.05` means 0.05%), by rescaling into `FUNDING_RATE_PRECISION_EXP` (1e9)
 * fixed-point via `FUNDING_RATE_BUFFER_PRECISION`.
 * @param rawFundingRate Raw funding rate estimate to convert.
 * @returns Plain percentage number (not a fraction — `1` means 1%, not 100%).
 */
const getFundingRatePct = (rawFundingRate: BN) => {
	return BigNum.from(
		rawFundingRate.mul(FUNDING_RATE_BUFFER_PRECISION),
		FUNDING_RATE_PRECISION_EXP
	).toNum();
};

/**
 * Calculates estimated funding rates in human-readable form (plain JS `number` percentages,
 * not BN), including a plain-English summary sentence. Values pass through floating-point
 * math and lose precision vs the underlying BN estimate — use `calculateAllEstimatedFundingRate`
 * or `calculateLongShortFundingRate` directly for anything that needs exact precision.
 * @param market Perp market to estimate funding for.
 * @param mmOraclePriceData Current MM oracle price data.
 * @param oraclePriceData Current oracle price data.
 * @param period `'hour'` for the hourly payment as a percentage, `'year'` for the payment annualized (assuming 24 funding payments/day) as an estimated APR.
 * @returns `longRate`/`shortRate`: signed percentage numbers from that side's own perspective — negative means that side pays funding, positive means that side receives it; `fundingRateUnit`: `'%'` or `'% APR'`; `formattedFundingRateSummary`: a human-readable sentence describing who pays whom.
 */
export function calculateFormattedLiveFundingRate(
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	oraclePriceData: OraclePriceData,
	period: 'hour' | 'year'
): {
	longRate: number;
	shortRate: number;
	fundingRateUnit: string;
	formattedFundingRateSummary: string;
} {
	const nowBN = new BN(Date.now() / 1000);

	const [_markTwapLive, _oracleTwapLive, longFundingRate, shortFundingRate] =
		calculateLongShortFundingRateAndLiveTwaps(
			market,
			mmOraclePriceData,
			oraclePriceData,
			undefined,
			nowBN
		);

	let longFundingRateNum = getFundingRatePct(longFundingRate);
	let shortFundingRateNum = getFundingRatePct(shortFundingRate);

	if (period == 'year') {
		const paymentsPerYear = 24 * 365.25;

		longFundingRateNum *= paymentsPerYear;
		shortFundingRateNum *= paymentsPerYear;
	}

	const longsArePaying = longFundingRateNum > 0;
	const shortsArePaying = !(shortFundingRateNum > 0);

	const longsAreString = longsArePaying ? 'pay' : 'receive';
	const shortsAreString = !shortsArePaying ? 'receive' : 'pay';

	const absoluteLongFundingRateNum = Math.abs(longFundingRateNum);
	const absoluteShortFundingRateNum = Math.abs(shortFundingRateNum);

	const formattedLongRatePct = absoluteLongFundingRateNum.toFixed(
		period == 'hour' ? 5 : 2
	);
	const formattedShortRatePct = absoluteShortFundingRateNum.toFixed(
		period == 'hour' ? 5 : 2
	);

	const fundingRateUnit = period == 'year' ? '% APR' : '%';

	const formattedFundingRateSummary = `At this rate, longs would ${longsAreString} ${formattedLongRatePct} ${fundingRateUnit} and shorts would ${shortsAreString} ${formattedShortRatePct} ${fundingRateUnit} at the end of the hour.`;

	return {
		longRate: longsArePaying
			? -absoluteLongFundingRateNum
			: absoluteLongFundingRateNum,
		shortRate: shortsArePaying
			? -absoluteShortFundingRateNum
			: absoluteShortFundingRateNum,
		fundingRateUnit: fundingRateUnit,
		formattedFundingRateSummary,
	};
}

function getMaxPriceDivergenceForFundingRate(
	market: PerpMarketAccount,
	oracleTwap: BN
) {
	if (isVariant(market.contractTier, 'a')) {
		return oracleTwap.divn(33);
	} else if (isVariant(market.contractTier, 'b')) {
		return oracleTwap.divn(33);
	} else if (isVariant(market.contractTier, 'c')) {
		return oracleTwap.divn(20);
	} else {
		return oracleTwap.divn(10);
	}
}

/**
 * Convenience wrapper around `calculateAllEstimatedFundingRate` that assigns its capped
 * (`cappedAltEst`) vs. uncapped (`interpEst`) estimate to the long/short side by comparing
 * `market.baseAssetAmountLong` against `market.baseAssetAmountShort`. When both sides are
 * equal, both get `interpEst`.
 * @param market Perp market to estimate funding for.
 * @param mmOraclePriceData Current MM oracle price data.
 * @param oraclePriceData Current oracle price data.
 * @param markPrice Optional mark price override.
 * @param now Current unix timestamp (seconds); defaults to wall-clock time.
 * @returns `[longFundingRateEst, shortFundingRateEst]`, same scale as `calculateAllEstimatedFundingRate`'s rate outputs.
 */
export function calculateLongShortFundingRate(
	market: PerpMarketAccount,
	mmOraclePriceData?: MMOraclePriceData,
	oraclePriceData?: OraclePriceData,
	markPrice?: BN,
	now?: BN
): [BN, BN] {
	const [_1, _2, _, cappedAltEst, interpEst] = calculateAllEstimatedFundingRate(
		market,
		mmOraclePriceData,
		oraclePriceData,
		markPrice,
		now
	);

	if (market.baseAssetAmountLong.gt(market.baseAssetAmountShort)) {
		return [cappedAltEst, interpEst];
	} else if (market.baseAssetAmountLong.lt(market.baseAssetAmountShort)) {
		return [interpEst, cappedAltEst];
	} else {
		return [interpEst, interpEst];
	}
}

/**
 * Same estimate assignment as `calculateLongShortFundingRate` (using
 * `market.baseAssetAmountLong` vs `market.baseAssetAmountShort.abs()` this time) but also
 * returns the live-projected mark/oracle TWAPs alongside the rate estimates.
 * @param market Perp market to estimate funding for.
 * @param mmOraclePriceData Current MM oracle price data.
 * @param oraclePriceData Current oracle price data.
 * @param markPrice Optional mark price override.
 * @param now Current unix timestamp (seconds); defaults to wall-clock time.
 * @returns `[markTwapLive, oracleTwapLive, longFundingRateEst, shortFundingRateEst]` — TWAPs in PRICE_PRECISION (1e6), rate estimates in the same scale as `calculateAllEstimatedFundingRate`.
 */
export function calculateLongShortFundingRateAndLiveTwaps(
	market: PerpMarketAccount,
	mmOraclePriceData?: MMOraclePriceData,
	oraclePriceData?: OraclePriceData,
	markPrice?: BN,
	now?: BN
): [BN, BN, BN, BN] {
	const [markTwapLive, oracleTwapLive, _2, cappedAltEst, interpEst] =
		calculateAllEstimatedFundingRate(
			market,
			mmOraclePriceData,
			oraclePriceData,
			markPrice,
			now
		);

	if (market.baseAssetAmountLong.gt(market.baseAssetAmountShort.abs())) {
		return [markTwapLive, oracleTwapLive, cappedAltEst, interpEst];
	} else if (market.baseAssetAmountLong.lt(market.baseAssetAmountShort.abs())) {
		return [markTwapLive, oracleTwapLive, interpEst, cappedAltEst];
	} else {
		return [markTwapLive, oracleTwapLive, interpEst, interpEst];
	}
}

/**
 * Estimated quote pool available to top up the smaller side's funding payment shortfall:
 * one-third of the AMM's own retained equity (`totalFeeMinusDistributions`), floored at
 * zero. Post-isolation there is no separate protocol floor to reserve — the AMM's own
 * equity is the only buffer.
 * @param market Perp market to evaluate.
 * @returns Estimated fee pool size, QUOTE_PRECISION (1e6).
 */
export function calculateFundingPool(market: PerpMarketAccount): BN {
	// todo
	// no protocol floor post-isolation: 1/3 of the AMM's own equity
	const feePool = BN.max(
		ZERO,
		market.amm.totalFeeMinusDistributions.mul(new BN(1)).div(new BN(3))
	);
	return feePool;
}
