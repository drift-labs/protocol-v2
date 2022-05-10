import { AMM, OracleGuardRails } from '../types';
import { OraclePriceData } from '../oracles/types';
import { ONE, ZERO } from '../constants/numericConstants';
import { BN } from '../index';

export function isOracleValid(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	slot: number
): boolean {
	const isOraclePriceNonPositive = oraclePriceData.price.lt(ZERO);
	const isOraclePriceTooVolatile =
		oraclePriceData.price
			.div(BN.max(ONE, amm.lastOraclePriceTwap))
			.gt(oracleGuardRails.validity.tooVolatileRatio) ||
		amm.lastOraclePriceTwap
			.div(BN.max(ONE, oraclePriceData.price))
			.gt(oracleGuardRails.validity.tooVolatileRatio);

	const isConfidenceTooLarge = oraclePriceData.price
		.div(BN.max(ONE, oraclePriceData.confidence))
		.lt(oracleGuardRails.validity.confidenceIntervalMaxSize);

	const oracleIsStale = oraclePriceData.slot
		.sub(new BN(slot))
		.gt(oracleGuardRails.validity.slotsBeforeStale);

	return !(
		!oraclePriceData.hasSufficientNumberOfDataPoints ||
		oracleIsStale ||
		isOraclePriceNonPositive ||
		isOraclePriceTooVolatile ||
		isConfidenceTooLarge
	);
}
