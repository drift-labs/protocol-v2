import { BN } from '@project-serum/anchor';
import { PythClient } from '../pythClient';
import { MARK_PRICE_PRECISION } from '../constants/numericConstants';
import { Market } from '../types';
import { calculateMarkPrice } from './market';

export async function calculateEstimatedFundingRate(
	market: Market,
	pythClient: PythClient,
	periodAdjustment: BN = new BN(1),
	estimationMethod: 'interpolated' | 'lowerbound'
): Promise<BN> {
	// periodAdjustment
	// 	1: hourly
	//  24: daily
	//  24 * 365.25: annualized
	const secondsInHour = new BN(3600);
	const hoursInDay = new BN(24);

	if (!market.initialized) {
		return new BN(0);
	}

	const payFreq = new BN(market.amm.fundingPeriod);

	const oraclePriceData = await pythClient.getPriceData(market.amm.oracle);
	const oracleTwapWithMantissa = new BN(
		oraclePriceData.twap.value * MARK_PRICE_PRECISION.toNumber()
	);

	const now = new BN((Date.now() / 1000).toFixed(0));
	const timeSinceLastUpdate = now.sub(market.amm.lastFundingRateTs);

	const lastMarkTwapWithMantissa = market.amm.lastMarkPriceTwap;
	const lastMarkPriceTwapTs = market.amm.lastMarkPriceTwapTs;

	const timeSinceLastMarkChange = now.sub(lastMarkPriceTwapTs);
	const markTwapTimeSinceLastUpdate = lastMarkPriceTwapTs.sub(
		market.amm.lastFundingRateTs
	);

	const baseAssetPriceWithMantissa = calculateMarkPrice(market);

	const markTwapWithMantissa = markTwapTimeSinceLastUpdate
		.mul(lastMarkTwapWithMantissa)
		.add(timeSinceLastMarkChange.mul(baseAssetPriceWithMantissa))
		.div(timeSinceLastMarkChange.add(markTwapTimeSinceLastUpdate));

	const twapSpread = markTwapWithMantissa.sub(oracleTwapWithMantissa);

	const twapSpreadPct = twapSpread
		.mul(MARK_PRICE_PRECISION)
		.mul(new BN(100))
		.div(oracleTwapWithMantissa);

	if (estimationMethod == 'lowerbound') {
		//assuming remaining funding period has no gap
		return twapSpreadPct
			.mul(payFreq)
			.mul(BN.min(secondsInHour, timeSinceLastUpdate))
			.mul(periodAdjustment)
			.div(secondsInHour)
			.div(secondsInHour)
			.div(hoursInDay);
	} else {
		return twapSpreadPct.mul(periodAdjustment).div(hoursInDay);
	}
}
