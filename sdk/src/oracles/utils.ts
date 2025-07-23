import { BN } from '@coral-xyz/anchor';
import { MMOraclePriceData } from './types';
import {
	FIVE,
	ONE,
	PERCENTAGE_PRECISION,
	TEN,
	ZERO,
} from '../constants/numericConstants';

export function getOraclePriceFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	if (
		mmOracleData.mmOracleSlot.gte(mmOracleData.oraclePriceData.slot) &&
		mmOracleData.mmOraclePrice.gt(ZERO)
	) {
		return mmOracleData.mmOraclePrice;
	} else {
		return mmOracleData.oraclePriceData.price;
	}
}

export function getOracleSlotFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	if (
		mmOracleData.mmOracleSlot.gte(mmOracleData.oraclePriceData.slot) &&
		mmOracleData.mmOraclePrice.gt(ZERO)
	) {
		return mmOracleData.mmOracleSlot;
	} else {
		return mmOracleData.oraclePriceData.slot;
	}
}

export function getOracleConfidenceFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	const priceDiffBps = mmOracleData.mmOraclePrice
		.sub(mmOracleData.oraclePriceData.price)
		.abs()
		.mul(PERCENTAGE_PRECISION)
		.div(BN.max(mmOracleData.oraclePriceData.price, ONE));
	if (
		mmOracleData.mmOracleSlot
			.sub(mmOracleData.oraclePriceData.slot)
			.abs()
			.lt(TEN) &&
		priceDiffBps.abs().gt(PERCENTAGE_PRECISION.div(new BN(2000))) // 5bps
	) {
		const mmOracleDiffPremium = mmOracleData.mmOraclePrice
			.sub(mmOracleData.oraclePriceData.price)
			.abs()
			.div(FIVE);
		return mmOracleData.oraclePriceData.confidence.add(mmOracleDiffPremium);
	} else {
		return mmOracleData.oraclePriceData.confidence;
	}
}
