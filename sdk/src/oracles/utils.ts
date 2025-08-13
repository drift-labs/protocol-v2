import { BN } from '@coral-xyz/anchor';
import { MMOraclePriceData } from './types';

export function getOracleConfidenceFromMMOracleData(
	mmOracleData: MMOraclePriceData
): BN {
	const mmOracleDiffPremium = mmOracleData.mmOraclePrice
		.sub(mmOracleData.oraclePriceData.price)
		.abs();
	return mmOracleData.oraclePriceData.confidence.add(mmOracleDiffPremium);
}
