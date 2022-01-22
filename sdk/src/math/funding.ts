import { BN } from '@project-serum/anchor';
import { PriceData } from '@pythnetwork/client';
import {
	AMM_RESERVE_PRECISION,
	MARK_PRICE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { Market } from '../types';
import { calculateMarkPrice } from './market';

/**
 *
 * @param market
 * @param pythClient
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateAllEstimatedFundingRate(
	market: Market,
	oraclePriceData: PriceData,
	periodAdjustment: BN = new BN(1)
): Promise<[BN, BN, BN, BN, BN]> {
	// periodAdjustment
	// 	1: hourly
	//  24: daily
	//  24 * 365.25: annualized
	const secondsInHour = new BN(3600);
	const hoursInDay = new BN(24);

	if (!market.initialized) {
		return [ZERO, ZERO, ZERO, ZERO, ZERO];
	}

	const payFreq = new BN(market.amm.fundingPeriod);

	// todo: sufficiently differs from blockchain timestamp?
	const now = new BN((Date.now() / 1000).toFixed(0));
	const timeSinceLastUpdate = now.sub(market.amm.lastFundingRateTs);

	// calculate real-time mark twap
	const lastMarkTwapWithMantissa = market.amm.lastMarkPriceTwap;
	const lastMarkPriceTwapTs = market.amm.lastMarkPriceTwapTs;

	const timeSinceLastMarkChange = now.sub(lastMarkPriceTwapTs);
	const markTwapTimeSinceLastUpdate = BN.max(
		secondsInHour,
		secondsInHour.sub(timeSinceLastMarkChange)
	);
	const baseAssetPriceWithMantissa = calculateMarkPrice(market);

	const markTwapWithMantissa = markTwapTimeSinceLastUpdate
		.mul(lastMarkTwapWithMantissa)
		.add(timeSinceLastMarkChange.mul(baseAssetPriceWithMantissa))
		.div(timeSinceLastMarkChange.add(markTwapTimeSinceLastUpdate));

	// calculate real-time (predicted) oracle twap
	// note: oracle twap depends on `when the chord is struck` (market is trade)
	const lastOracleTwapWithMantissa = market.amm.lastOraclePriceTwap;
	const lastOraclePriceTwapTs = market.amm.lastOraclePriceTwapTs;

	const timeSinceLastOracleTwapUpdate = now.sub(lastOraclePriceTwapTs);
	const oracleTwapTimeSinceLastUpdate = BN.max(
		secondsInHour,
		secondsInHour.sub(timeSinceLastOracleTwapUpdate)
	);

	// verify pyth input is positive for live update
	let oracleStablePriceNum = 0;
	let oracleInputCount = 0;
	if (oraclePriceData.price >= 0) {
		oracleStablePriceNum += oraclePriceData.price;
		oracleInputCount += 1;
	}
	if (oraclePriceData.previousPrice >= 0) {
		oracleStablePriceNum += oraclePriceData.previousPrice;
		oracleInputCount += 1;
	}

	oracleStablePriceNum = oracleStablePriceNum / oracleInputCount;
	const oraclePriceStableWithMantissa = new BN(
		oracleStablePriceNum * MARK_PRICE_PRECISION.toNumber()
	);

	let oracleTwapWithMantissa = lastOracleTwapWithMantissa;

	const oracleLiveVsTwap = oraclePriceStableWithMantissa
		.sub(lastOracleTwapWithMantissa)
		.abs()
		.mul(MARK_PRICE_PRECISION)
		.mul(new BN(100))
		.div(lastOracleTwapWithMantissa);

	// verify pyth live input is within 10% of last twap for live update
	if (oracleLiveVsTwap.lte(MARK_PRICE_PRECISION.mul(new BN(10)))) {
		oracleTwapWithMantissa = oracleTwapTimeSinceLastUpdate
			.mul(lastOracleTwapWithMantissa)
			.add(timeSinceLastMarkChange.mul(oraclePriceStableWithMantissa))
			.div(timeSinceLastOracleTwapUpdate.add(oracleTwapTimeSinceLastUpdate));
	}

	const twapSpread = lastMarkTwapWithMantissa.sub(lastOracleTwapWithMantissa);

	const twapSpreadPct = twapSpread
		.mul(MARK_PRICE_PRECISION)
		.mul(new BN(100))
		.div(oracleTwapWithMantissa);

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
		.div(MARK_PRICE_PRECISION.div(QUOTE_PRECISION));
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
			return [
				markTwapWithMantissa,
				oracleTwapWithMantissa,
				lowerboundEst,
				interpEst,
				interpEst,
			];
		}
	} else if (market.baseAssetAmountLong.lt(market.baseAssetAmountShort.abs())) {
		largerSide = market.baseAssetAmountShort.abs();
		smallerSide = market.baseAssetAmountLong.abs();
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
			.mul(MARK_PRICE_PRECISION.div(QUOTE_PRECISION))
			.mul(AMM_RESERVE_PRECISION);
		cappedAltEst = cappedAltEst.add(feePoolTopOff).div(largerSide);

		cappedAltEst = cappedAltEst
			.mul(MARK_PRICE_PRECISION)
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
	market: Market,
	oraclePriceData: PriceData,
	periodAdjustment: BN = new BN(1),
	estimationMethod: 'interpolated' | 'lowerbound' | 'capped'
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
	market: Market,
	oraclePriceData: PriceData,
	periodAdjustment: BN = new BN(1)
): Promise<[BN, BN]> {
	const [_1, _2, _, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			periodAdjustment
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
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateLongShortFundingRateAndLiveTwaps(
	market: Market,
	oraclePriceData: PriceData,
	periodAdjustment: BN = new BN(1)
): Promise<[BN, BN, BN, BN]> {
	const [markTwapLive, oracleTwapLive, _2, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			periodAdjustment
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
 *
 * @param market
 * @returns Estimated fee pool size
 */
export function calculateFundingPool(market: Market): BN {
	// todo
	const totalFeeLB = market.amm.totalFee.div(new BN(2));
	const feePool = BN.max(
		ZERO,
		market.amm.totalFeeMinusDistributions.sub(totalFeeLB)
	);
	return feePool;
}
