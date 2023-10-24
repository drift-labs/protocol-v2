import { BN } from '@coral-xyz/anchor';
import {
	AMM_RESERVE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
	ONE,
	FUNDING_RATE_OFFSET_DENOMINATOR,
} from '../constants/numericConstants';
import { PerpMarketAccount, isVariant } from '../types';
import { OraclePriceData } from '../oracles/types';
import { calculateBidAskPrice } from './amm';
import { calculateLiveOracleTwap } from './oracles';

function calculateLiveMarkTwap(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	markPrice?: BN,
	now?: BN,
	period = new BN(3600)
): BN {
	now = now || new BN((Date.now() / 1000).toFixed(0));

	const lastMarkTwapWithMantissa = market.amm.lastMarkPriceTwap;
	const lastMarkPriceTwapTs = market.amm.lastMarkPriceTwapTs;

	const timeSinceLastMarkChange = now.sub(lastMarkPriceTwapTs);
	const markTwapTimeSinceLastUpdate = BN.max(
		period,
		BN.max(ZERO, period.sub(timeSinceLastMarkChange))
	);

	if (!markPrice) {
		const [bid, ask] = calculateBidAskPrice(market.amm, oraclePriceData);
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
		market.amm.lastMarkPriceTwapTs.gt(
			market.amm.historicalOracleData.lastOraclePriceTwapTs
		)
	) {
		// shrink oracle based on invalid intervals
		const oracleInvalidDuration = BN.max(
			ZERO,
			market.amm.lastMarkPriceTwapTs.sub(
				market.amm.historicalOracleData.lastOraclePriceTwapTs
			)
		);
		const timeSinceLastOracleTwapUpdate = now.sub(
			market.amm.historicalOracleData.lastOraclePriceTwapTs
		);
		const oracleTwapTimeSinceLastUpdate = BN.max(
			ONE,
			BN.min(
				market.amm.fundingPeriod,
				BN.max(ONE, market.amm.fundingPeriod.sub(timeSinceLastOracleTwapUpdate))
			)
		);
		newOracleTwap = oracleTwapTimeSinceLastUpdate
			.mul(oracleTwapWithMantissa)
			.add(oracleInvalidDuration.mul(markTwapWithMantissa))
			.div(oracleTwapTimeSinceLastUpdate.add(oracleInvalidDuration));
	} else if (
		market.amm.lastMarkPriceTwapTs.lt(
			market.amm.historicalOracleData.lastOraclePriceTwapTs
		)
	) {
		// shrink mark to oracle twap over tradless intervals
		const tradelessDuration = BN.max(
			ZERO,
			market.amm.historicalOracleData.lastOraclePriceTwapTs.sub(
				market.amm.lastMarkPriceTwapTs
			)
		);
		const timeSinceLastMarkTwapUpdate = now.sub(market.amm.lastMarkPriceTwapTs);
		const markTwapTimeSinceLastUpdate = BN.max(
			ONE,
			BN.min(
				market.amm.fundingPeriod,
				BN.max(ONE, market.amm.fundingPeriod.sub(timeSinceLastMarkTwapUpdate))
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
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateAllEstimatedFundingRate(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	markPrice?: BN,
	now?: BN
): Promise<[BN, BN, BN, BN, BN]> {
	if (isVariant(market.status, 'uninitialized')) {
		return [ZERO, ZERO, ZERO, ZERO, ZERO];
	}

	// todo: sufficiently differs from blockchain timestamp?
	now = now || new BN((Date.now() / 1000).toFixed(0));

	// calculate real-time mark and oracle twap
	const liveMarkTwap = calculateLiveMarkTwap(
		market,
		oraclePriceData,
		markPrice,
		now,
		market.amm.fundingPeriod
	);
	const liveOracleTwap = calculateLiveOracleTwap(
		market.amm.historicalOracleData,
		oraclePriceData,
		now,
		market.amm.fundingPeriod
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
	const twapSpreadWithOffset = twapSpread.add(
		oracleTwap.abs().div(FUNDING_RATE_OFFSET_DENOMINATOR)
	);

	const twapSpreadPct = twapSpreadWithOffset
		.mul(PRICE_PRECISION)
		.mul(new BN(100))
		.div(oracleTwap);

	const secondsInHour = new BN(3600);
	const hoursInDay = new BN(24);
	const timeSinceLastUpdate = now.sub(market.amm.lastFundingRateTs);

	const lowerboundEst = twapSpreadPct
		.mul(market.amm.fundingPeriod)
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
	if (
		market.amm.baseAssetAmountLong.gt(market.amm.baseAssetAmountShort.abs())
	) {
		largerSide = market.amm.baseAssetAmountLong.abs();
		smallerSide = market.amm.baseAssetAmountShort.abs();
		if (twapSpread.gt(new BN(0))) {
			return [markTwap, oracleTwap, lowerboundEst, interpEst, interpEst];
		}
	} else if (
		market.amm.baseAssetAmountLong.lt(market.amm.baseAssetAmountShort.abs())
	) {
		largerSide = market.amm.baseAssetAmountShort.abs();
		smallerSide = market.amm.baseAssetAmountLong.abs();
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
 *
 * @param market
 * @param oraclePriceData
 * @param periodAdjustment
 * @returns Estimated funding rate. : Precision //TODO-PRECISION
 */
export async function calculateLongShortFundingRate(
	market: PerpMarketAccount,
	oraclePriceData?: OraclePriceData,
	markPrice?: BN,
	now?: BN
): Promise<[BN, BN]> {
	const [_1, _2, _, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			markPrice,
			now
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
	markPrice?: BN,
	now?: BN
): Promise<[BN, BN, BN, BN]> {
	const [markTwapLive, oracleTwapLive, _2, cappedAltEst, interpEst] =
		await calculateAllEstimatedFundingRate(
			market,
			oraclePriceData,
			markPrice,
			now
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
