import { BN, ONE, ZERO } from '../';

export function clampBN(x: BN, min: BN, max: BN): BN {
	return BN.max(min, BN.min(x, max));
}

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

export const divCeil = (a: BN, b: BN): BN => {
	const quotient = a.div(b);

	const remainder = a.mod(b);

	if (remainder.gt(ZERO)) {
		return quotient.add(ONE);
	} else {
		return quotient;
	}
};

export const sigNum = (x: BN): BN => {
	return x.isNeg() ? new BN(-1) : new BN(1);
};

/**
 * calculates the time remaining until the next update based on a rounded, "on-the-hour" update schedule
 * this schedule is used for Perpetual Funding Rate and Revenue -> Insurance Updates
 * @param now: current blockchain unix timestamp
 * @param lastUpdateTs: the unix timestamp of the last update
 * @param updatePeriod: desired interval between updates (in seconds)
 * @returns: timeRemainingUntilUpdate (in seconds)
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

export const checkSameDate = (dateString1: string, dateString2: string) => {
	const date1 = new Date(dateString1);
	const date2 = new Date(dateString2);

	const isSameDate =
		date1.getDate() === date2.getDate() &&
		date1.getMonth() === date2.getMonth() &&
		date1.getFullYear() === date2.getFullYear();

	return isSameDate;
};

export function isBNSafe(number: number): boolean {
	return number <= 0x1fffffffffffff;
}

/**
 * Converts a number to BN makes sure the number is safe to convert to BN (that it does not overflow number after multiplying by precision)
 * @param number the number to convert to BN
 * @param precision the BN precision to use (i.e. QUOTE_PRECISION and BASE_PRECISION from drift sdk)
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
