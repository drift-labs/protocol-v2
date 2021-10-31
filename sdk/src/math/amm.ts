import { BN } from '@project-serum/anchor';
import { AMM_MANTISSA, PEG_SCALAR } from '../clearingHouse';
import { ZERO } from '../constants/numericConstants';

export function calculateCurvePriceWithMantissa(
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetAmount
		.mul(AMM_MANTISSA)
		.mul(peg)
		.div(PEG_SCALAR)
		.div(baseAssetAmount);
}
