import { BN } from '@coral-xyz/anchor';
import {
	AMM_RESERVE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { PerpMarketAccount, isVariant } from '../types';
import { OraclePriceData } from '../oracles/types';
import { calculateBidAskPrice } from './amm';

/**
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateAllEstimatedFundingRate(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	periodAdjustment: BN = new BN(1),
	now?: BN
): Promise<[BN, BN, BN, BN, BN]> {
	// periodAdjustment
	// 	1: hourly
	//  24: daily
	//  24 * 365.25: annualized
	const secondsInHour = new BN(3600);
	const hoursInDay = new BN(24);
	const ONE = new BN(1);

	if (isVariant(market.status, 'uninitialized')) {
		return [ZERO, ZERO, ZERO, ZERO, ZERO];
	}

	const payFreq = new BN(market.amm.fundingPeriod);

	// todo: sufficiently differs from blockchain timestamp?
	now = now || new BN((Date.now() / 1000).toFixed(0));
	const timeSinceLastUpdate = now.sub(market.amm.lastFundingRateTs);

	// calculate real-time mark twap
	const lastMarkTwapWithMantissa = market.amm.lastMarkPriceTwap;
	const lastMarkPriceTwapTs = market.amm.lastMarkPriceTwapTs;

	const timeSinceLastMarkChange = now.sub(lastMarkPriceTwapTs);
	const markTwapTimeSinceLastUpdate = BN.max(
		secondsInHour,
		BN.max(ZERO, secondsInHour.sub(timeSinceLastMarkChange))
	);
	const [bid, ask] = calculateBidAskPrice(market.amm, oraclePriceData);
	const baseAssetPriceWithMantissa = bid.add(ask).div(new BN(2));

	const markTwapWithMantissa = markTwapTimeSinceLastUpdate
		.mul(lastMarkTwapWithMantissa)
		.add(timeSinceLastMarkChange.mul(baseAssetPriceWithMantissa))
		.div(timeSinceLastMarkChange.add(markTwapTimeSinceLastUpdate));

	// calculate real-time (predicted) oracle twap
	// note: oracle twap depends on `when the chord is struck` (market is trade)
	const lastOracleTwapWithMantissa =
		market.amm.historicalOracleData.lastOraclePriceTwap;
	const lastOraclePriceTwapTs =
		market.amm.historicalOracleData.lastOraclePriceTwapTs;

	const oracleInvalidDuration = BN.max(
		ZERO,
		lastMarkPriceTwapTs.sub(lastOraclePriceTwapTs)
	);

	const timeSinceLastOracleTwapUpdate = now.sub(lastOraclePriceTwapTs);
	const oracleTwapTimeSinceLastUpdate = BN.max(
		ONE,
		BN.min(
			secondsInHour,
			BN.max(ONE, secondsInHour.sub(timeSinceLastOracleTwapUpdate))
		)
	);
	let oracleTwapWithMantissa = lastOracleTwapWithMantissa;

	// if passing live oracle data, improve predicted calc estimate
	if (oraclePriceData) {
		const oraclePrice = oraclePriceData.price;

		const oracleLiveVsTwap = oraclePrice
			.sub(lastOracleTwapWithMantissa)
			.abs()
			.mul(PRICE_PRECISION)
			.mul(new BN(100))
			.div(lastOracleTwapWithMantissa);

		// verify pyth live input is within 20% of last twap for live update
		if (oracleLiveVsTwap.lte(PRICE_PRECISION.mul(new BN(20)))) {
			oracleTwapWithMantissa = oracleTwapTimeSinceLastUpdate
				.mul(lastOracleTwapWithMantissa)
				.add(timeSinceLastMarkChange.mul(oraclePrice))
				.div(timeSinceLastMarkChange.add(oracleTwapTimeSinceLastUpdate));
		}
	}

	const shrunkLastOracleTwapwithMantissa = oracleTwapTimeSinceLastUpdate
		.mul(oracleTwapWithMantissa)
		.add(oracleInvalidDuration.mul(lastMarkTwapWithMantissa))
		.div(oracleTwapTimeSinceLastUpdate.add(oracleInvalidDuration));

	const twapSpread = markTwapWithMantissa.sub(shrunkLastOracleTwapwithMantissa);

	const twapSpreadPct = twapSpread
		.mul(PRICE_PRECISION)
		.mul(new BN(100))
		.div(shrunkLastOracleTwapwithMantissa);

	const lowerboundEst = twapSpreadPct
		.mul(payFreq)
		.mul(BN.min(secondsInHour, timeSinceLastUpdate))
		.mul(periodAdjustment)
		.div(secondsInHour)
		.div(secondsInHour)
		.div(hoursInDay);

	const interpEst = twapSpreadPct.mul(periodAdjustment).div(hoursInDay);

	const interpRateQuote = twapSpreadPct
		.mul(periodAdjustment)
		.div(hoursInDay)
		.div(PRICE_PRECISION.div(QUOTE_PRECISION));

	let feePoolSize = calculateFundingPool(market);
	if (interpRateQuote.lt(new BN(0))) {
		feePoolSize = feePoolSize.mul(new BN(-1));
	}

	let cappedAltEst: BN;
	let largerSide: BN;
	let smallerSide: BN;
	if (
		market.amm.baseAssetAmountLong.gt(market.amm.baseAssetAmountShort.abs())
	) {
		largerSide = market.amm.baseAssetAmountLong.abs();
		smallerSide = market.amm.baseAssetAmountShort.abs();
		if (twapSpread.gt(new BN(0))) {
			return [
				markTwapWithMantissa,
				oracleTwapWithMantissa,
				lowerboundEst,
				interpEst,
				interpEst,
			];
		}
	} else if (
		market.amm.baseAssetAmountLong.lt(market.amm.baseAssetAmountShort.abs())
	) {
		largerSide = market.amm.baseAssetAmountShort.abs();
		smallerSide = market.amm.baseAssetAmountLong.abs();
		if (twapSpread.lt(new BN(0))) {
			return [
				markTwapWithMantissa,
				oracleTwapWithMantissa,
				lowerboundEst,
				interpEst,
				interpEst,
			];
		}
	} else {
		return [
			markTwapWithMantissa,
			oracleTwapWithMantissa,
			lowerboundEst,
			interpEst,
			interpEst,
		];
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
			.div(oracleTwapWithMantissa)
			.mul(periodAdjustment);

		if (cappedAltEst.abs().gte(interpEst.abs())) {
			cappedAltEst = interpEst;
		}
	} else {
		cappedAltEst = interpEst;
	}

	return [
		markTwapWithMantissa,
		oracleTwapWithMantissa,
		lowerboundEst,
		cappedAltEst,
		interpEst,
	];
}

/**
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @param estimationMethod
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateEstimatedFundingRate(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	periodAdjustment: BN = new BN(1),
	estimationMethod?: 'interpolated' | 'lowerbound' | 'capped'
): Promise<BN> {
	const [_1, _2, lowerboundEst, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			periodAdjustment
		);

	if (estimationMethod == 'lowerbound') {
		//assuming remaining funding period has no gap
		return lowerboundEst;
	} else if (estimationMethod == 'capped') {
		return cappedAltEst;
	} else {
		return interpEst;
	}
}

/**
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateLongShortFundingRate(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	periodAdjustment: BN = new BN(1)
): Promise<[BN, BN]> {
	const [_1, _2, _, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			periodAdjustment
		);

	if (market.amm.baseAssetAmountLong.gt(market.amm.baseAssetAmountShort)) {
		return [cappedAltEst, interpEst];
	} else if (
		market.amm.baseAssetAmountLong.lt(market.amm.baseAssetAmountShort)
	) {
		return [interpEst, cappedAltEst];
	} else {
		return [interpEst, interpEst];
	}
}

/**
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateLongShortFundingRateAndLiveTwaps(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	periodAdjustment: BN = new BN(1)
): Promise<[BN, BN, BN, BN]> {
	const [markTwapLive, oracleTwapLive, _2, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			periodAdjustment
		);

	if (
		market.amm.baseAssetAmountLong.gt(market.amm.baseAssetAmountShort.abs())
	) {
		return [markTwapLive, oracleTwapLive, cappedAltEst, interpEst];
	} else if (
		market.amm.baseAssetAmountLong.lt(market.amm.baseAssetAmountShort.abs())
	) {
		return [markTwapLive, oracleTwapLive, interpEst, cappedAltEst];
	} else {
		return [markTwapLive, oracleTwapLive, interpEst, interpEst];
	}
}

/**
 *
 * @param market
 * @returns Estimated fee pool size
 */
export function calculateFundingPool(market: PerpMarketAccount): BN {
	// todo
	const totalFeeLB = market.amm.totalExchangeFee.div(new BN(2));
	const feePool = BN.max(
		ZERO,
		market.amm.totalFeeMinusDistributions
			.sub(totalFeeLB)
			.mul(new BN(1))
			.div(new BN(3))
	);
	return feePool;
}
