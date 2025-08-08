import { BN } from '@coral-xyz/anchor';
import { OraclePriceData } from './types';

export function getOracleConfidenceFromMMOracleData(
	mmOraclePrice: BN,
	oraclePriceData: OraclePriceData
): BN {
	const mmOracleDiffPremium = mmOraclePrice.sub(oraclePriceData.price).abs();
	return oraclePriceData.confidence.add(mmOracleDiffPremium);
}
