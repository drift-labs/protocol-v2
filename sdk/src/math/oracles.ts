import { AMM, OracleGuardRails } from '../types';
import { OraclePriceData } from '../oracles/types';
import {
	BID_ASK_SPREAD_PRECISION,
	ONE,
	ZERO,
} from '../constants/numericConstants';
import { BN } from '../index';

export function isOracleValid(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	slot: number
): boolean {
	const isOraclePriceNonPositive = oraclePriceData.price.lte(ZERO);
	const isOraclePriceTooVolatile =
		oraclePriceData.price
			.div(BN.max(ONE, amm.lastOraclePriceTwap))
			.gt(oracleGuardRails.validity.tooVolatileRatio) ||
		amm.lastOraclePriceTwap
			.div(BN.max(ONE, oraclePriceData.price))
			.gt(oracleGuardRails.validity.tooVolatileRatio);

	const isConfidenceTooLarge = new BN(amm.baseSpread)
		.add(BN.max(ONE, oraclePriceData.confidence))
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(oraclePriceData.price)
		.gt(new BN(amm.maxSpread));

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
