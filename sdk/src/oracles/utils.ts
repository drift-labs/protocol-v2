import { BN } from '@coral-xyz/anchor';
import { MMOraclePriceData } from './types';
import { FIVE } from '../constants/numericConstants';

export function getOracleConfidenceFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	const mmOracleDiffPremium = mmOracleData.mmOraclePrice
		.sub(mmOracleData.oraclePriceData.price)
		.abs()
		.div(FIVE);
	return mmOracleData.oraclePriceData.confidence.add(mmOracleDiffPremium);
}
