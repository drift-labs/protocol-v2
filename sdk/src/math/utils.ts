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
