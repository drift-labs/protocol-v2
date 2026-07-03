import { BN } from '../isomorphic/anchor';
import { PRICE_PRECISION } from '../constants/numericConstants';

/**
 * Converts a fixed-point `BN` into a human-readable JS `number` by dividing out `precision`.
 * Correctly handles negative `bigNumber` values: `bn.js`'s `.div()`/`.mod()` truncate toward
 * zero (matching JS `%` semantics), so the whole and fractional parts recombine with consistent
 * sign without needing separate negative-number handling. Precision beyond what a JS `number`
 * (IEEE-754 double) can represent exactly may be lost — this is a display/estimation helper, not
 * for further on-chain-precision math.
 *
 * @param {BN} bigNumber - The value to convert; `null`/`undefined` return 0 (a `BN` instance for
 *   zero is still an object and thus truthy, so it falls through to the normal division below)
 * @param {BN} [precision] - The fixed-point precision to divide out; defaults to `PRICE_PRECISION` (1e6)
 * @return {number} The value as a JS number, in the same units `precision` represents one whole unit of
 */
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

/**
 * Converts a human-readable JS `number` into a fixed-point `BN` scaled by `precision`. The
 * fractional part is rounded (`Math.round`) to the nearest unit of `precision`, not truncated.
 *
 * @param {number} value - The human-readable value to convert
 * @param {BN} precision - The fixed-point precision to scale by (e.g. `QUOTE_PRECISION`, `BASE_PRECISION`)
 * @return {BN} `value` scaled by `precision`
 */
export function convertToBN(value: number, precision: BN): BN {
	// Get the whole part using Math.floor
	const wholePart = Math.floor(value);

	// Get decimal part by subtracting whole part and multiplying by precision
	const decimalPart = Math.round((value - wholePart) * precision.toNumber());

	// Combine: wholePart * PRECISION + decimalPart
	return new BN(wholePart).mul(precision).add(new BN(decimalPart));
}
