import { BN } from '../isomorphic/anchor';
import { ONE, ZERO } from '../constants/numericConstants';

/**
 * Clamps `x` to the inclusive range `[min, max]`.
 *
 * @param {BN} x - The value to clamp
 * @param {BN} min - The lower bound
 * @param {BN} max - The upper bound
 * @return {BN} `x` if within range, otherwise `min` or `max`
 */
export function clampBN(x: BN, min: BN, max: BN): BN {
	return BN.max(min, BN.min(x, max));
}

/**
 * Integer square root via binary recursion, floored to the nearest integer (i.e.
 * `squareRootBN(n) === Math.floor(Math.sqrt(n))` for values representable as a double). Used
 * throughout the AMM math wherever the program takes an integer sqrt of the constant-product
 * invariant.
 *
 * @param {BN} n - A non-negative integer
 * @return {BN} `floor(sqrt(n))`
 * @throws {Error} If `n` is negative
 */
export const squareRootBN = (n: BN): BN => {
	if (n.lt(new BN(0))) {
		throw new Error('Sqrt only works on non-negtiave inputs');
	}
	if (n.lt(new BN(2))) {
		return n;
	}

	const smallCand = squareRootBN(n.shrn(2)).shln(1);
	const largeCand = smallCand.add(new BN(1));

	if (largeCand.mul(largeCand).gt(n)) {
		return smallCand;
	} else {
		return largeCand;
	}
};

/**
 * Integer division rounded up (ceiling), mirroring the program's unsigned `safe_div_ceil` (e.g.
 * used for borrow token amounts, where rounding up favors the protocol/lenders over the
 * borrower). Only meaningful for non-negative operands — `bn.js`'s `.mod()` returns a remainder
 * with the sign of the dividend, so this is not a general-purpose ceiling division for signed
 * inputs.
 *
 * @param {BN} a - The dividend (expected non-negative)
 * @param {BN} b - The divisor (expected positive)
 * @return {BN} `ceil(a / b)`
 */
export const divCeil = (a: BN, b: BN): BN => {
	const quotient = a.div(b);

	const remainder = a.mod(b);

	if (remainder.gt(ZERO)) {
		return quotient.add(ONE);
	} else {
		return quotient;
	}
};

/**
 * Sign function returning ±1 (never 0).
 *
 * @param {BN} x - The value to test
 * @return {BN} `-1` if `x` is negative, otherwise `1` (including for zero)
 */
export const sigNum = (x: BN): BN => {
	return x.isNeg() ? new BN(-1) : new BN(1);
};

/**
 * Calculates the time remaining until the next update is eligible under a rounded, "on-the-hour"
 * update schedule. Used for perp funding rate updates and revenue-to-insurance-fund sweeps: if the
 * last update landed within 1/3 of `updatePeriod` of an hour boundary, the next update is allowed
 * on that boundary; otherwise it's pushed to the following boundary (two periods out) to avoid
 * drifting the schedule off-hour. Returns zero once the wait has already elapsed.
 *
 * @param {BN} now - Current unix timestamp, seconds
 * @param {BN} lastUpdateTs - Unix timestamp of the last update, seconds
 * @param {BN} updatePeriod - Desired interval between updates, seconds
 * @return {BN} Seconds remaining until the next update is eligible (zero if already due)
 */
export function timeRemainingUntilUpdate(
	now: BN,
	lastUpdateTs: BN,
	updatePeriod: BN
): BN {
	const timeSinceLastUpdate = now.sub(lastUpdateTs);

	// round next update time to be available on the hour
	let nextUpdateWait = updatePeriod;
	if (updatePeriod.gt(new BN(1))) {
		const lastUpdateDelay = lastUpdateTs.umod(updatePeriod);
		if (!lastUpdateDelay.isZero()) {
			const maxDelayForNextPeriod = updatePeriod.div(new BN(3));

			const twoFundingPeriods = updatePeriod.mul(new BN(2));

			if (lastUpdateDelay.gt(maxDelayForNextPeriod)) {
				// too late for on the hour next period, delay to following period
				nextUpdateWait = twoFundingPeriods.sub(lastUpdateDelay);
			} else {
				// allow update on the hour
				nextUpdateWait = updatePeriod.sub(lastUpdateDelay);
			}

			if (nextUpdateWait.gt(twoFundingPeriods)) {
				nextUpdateWait = nextUpdateWait.sub(updatePeriod);
			}
		}
	}
	const timeRemainingUntilUpdate = nextUpdateWait
		.sub(timeSinceLastUpdate)
		.isNeg()
		? ZERO
		: nextUpdateWait.sub(timeSinceLastUpdate);

	return timeRemainingUntilUpdate;
}

/**
 * Compares two date strings for equality by calendar day (year/month/date), ignoring
 * time-of-day. Uses the local `getDate()`/`getMonth()`/`getFullYear()` getters, so the
 * comparison is against the process's local-timezone calendar day (not UTC).
 *
 * @param {string} dateString1 - A date string parseable by `new Date()`
 * @param {string} dateString2 - A date string parseable by `new Date()`
 * @return {boolean} Whether both parse to the same calendar day
 */
export const checkSameDate = (dateString1: string, dateString2: string) => {
	const date1 = new Date(dateString1);
	const date2 = new Date(dateString2);

	const isSameDate =
		date1.getDate() === date2.getDate() &&
		date1.getMonth() === date2.getMonth() &&
		date1.getFullYear() === date2.getFullYear();

	return isSameDate;
};

/**
 * True if `number` is within `Number.MAX_SAFE_INTEGER` (2^53 - 1), i.e. safe to convert to a
 * `BN` via a JS `number` without losing precision.
 *
 * @param {number} number - The value to check (typically already multiplied by a target precision)
 * @return {boolean} Whether `number` can be represented exactly as a JS number
 */
export function isBNSafe(number: number): boolean {
	return number <= 0x1fffffffffffff;
}

/**
 * Converts a human-readable JS `number` into a `BN` scaled by `precision`, routing through a
 * string conversion (`number.toString()` for whole numbers) instead of `number * precision` when
 * the naive multiplication would exceed `Number.MAX_SAFE_INTEGER` (per `isBNSafe`), avoiding
 * silent floating-point precision loss for large inputs. Note a fractional input whose scaled
 * value exceeds `Number.MAX_SAFE_INTEGER` has its fractional part truncated (`bn.js` accepts only
 * integer numbers); this is intentional and pinned by `tests/bn/test.ts`.
 *
 * @param {number} number - The human-readable amount to convert
 * @param {BN} precision - The target fixed-point precision (e.g. `QUOTE_PRECISION`, `BASE_PRECISION`)
 * @return {BN} `number` scaled by `precision`
 */
export function numberToSafeBN(number: number, precision: BN): BN {
	// check if number has decimals
	const candidate = number * precision.toNumber();
	if (isBNSafe(candidate)) {
		return new BN(candidate);
	} else {
		if (number % 1 === 0) {
			return new BN(number.toString()).mul(precision);
		} else {
			return new BN(number).mul(precision);
		}
	}
}
