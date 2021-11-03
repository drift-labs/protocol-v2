import { AMM_MANTISSA, BN, PEG_SCALAR } from '@moet/sdk';

export const stripMantissa = (bigNumber: BN, precision: BN = AMM_MANTISSA) => {
	if (!bigNumber) return 0;
	return (
		bigNumber.div(precision).toNumber() +
		bigNumber.mod(precision).toNumber() / precision.toNumber()
	);
};

export const stripBaseAssetPrecision = (baseAssetAmount: BN) => {
	return stripMantissa(baseAssetAmount, AMM_MANTISSA.mul(PEG_SCALAR));
};