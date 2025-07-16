import { BN } from '@coral-xyz/anchor';
import { MMOraclePriceData } from './types';
import { ZERO } from '../constants/numericConstants';

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
