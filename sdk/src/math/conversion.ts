import { BN } from '../';
import { PRICE_PRECISION } from '../constants/numericConstants';

export const convertToNumber = (
	bigNumber: BN,
	precision: BN = PRICE_PRECISION
) => {
	if (!bigNumber) return 0;
	return (
		bigNumber.div(precision).toNumber() +
		bigNumber.mod(precision).toNumber() / precision.toNumber()
	);
};

export function convertToBN(value: number, precision: BN): BN {
	// Get the whole part using Math.floor
	const wholePart = Math.floor(value);

	// Get decimal part by subtracting whole part and multiplying by precision
	const decimalPart = Math.round((value - wholePart) * precision.toNumber());

	// Combine: wholePart * PRECISION + decimalPart
	return new BN(wholePart).mul(precision).add(new BN(decimalPart));
}
