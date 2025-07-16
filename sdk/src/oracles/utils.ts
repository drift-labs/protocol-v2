import { BN } from '@coral-xyz/anchor';
import { MMOraclePriceData } from './types';

export function getOraclePriceFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	if (mmOracleData.mmOracleSlot.gte(mmOracleData.oraclePriceData.slot)) {
		return mmOracleData.mmOraclePrice;
	} else {
		return mmOracleData.oraclePriceData.price;
	}
}

export function getOracleSlotFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	if (mmOracleData.mmOracleSlot.gte(mmOracleData.oraclePriceData.slot)) {
		return mmOracleData.mmOracleSlot;
	} else {
		return mmOracleData.oraclePriceData.slot;
	}
}
