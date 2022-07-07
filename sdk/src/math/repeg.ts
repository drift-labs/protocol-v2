import { BN } from '@project-serum/anchor';
import {
	MARK_PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	PEG_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { AMM } from '../types';
/**
 * Helper function calculating adjust k cost
 * @param amm
 * @param numerator
 * @param denomenator
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateAdjustKCost(
	amm: AMM,
	numerator: BN,
	denomenator: BN
): BN {
	// const k = market.amm.sqrtK.mul(market.amm.sqrtK);
	const x = amm.baseAssetReserve;
	const y = amm.quoteAssetReserve;

	const d = amm.netBaseAssetAmount;
	const Q = amm.pegMultiplier;

	const quoteScale = y.mul(d).mul(Q); //.div(AMM_RESERVE_PRECISION);

	const p = numerator.mul(MARK_PRICE_PRECISION).div(denomenator);

	const cost = quoteScale
		.div(x.add(d))
		.sub(
			quoteScale
				.mul(p)
				.div(MARK_PRICE_PRECISION)
				.div(x.mul(p).div(MARK_PRICE_PRECISION).add(d))
		)
		.div(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(PEG_PRECISION);

	return cost.mul(new BN(-1));
}

/**
 * Helper function calculating adjust pegMultiplier (repeg) cost
 *
 * @param amm
 * @param newPeg
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateRepegCost(amm: AMM, newPeg: BN): BN {
	// const dqar = amm.quoteAssetAmountLong.sub(amm.quoteAssetAmountShort);
	const dqar = amm.quoteAssetReserve.sub(amm.terminalQuoteAssetReserve);
	const cost = dqar
		.mul(newPeg.sub(amm.pegMultiplier))
		.div(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(PEG_PRECISION);
	// console.log('dqar cost', dqar, cost);
	return cost;
}

export function calculateBudgetedK(amm: AMM, cost: BN): [BN, BN] {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*d*d*Q)

	// numer
	//   =  y*d*d*Q - Cxd - Cdd
	//   =  y/x*Q*d*d - Cd - Cd/x
	//   = mark      - C/d - C/(x)
	//   =  mark/C    - 1/d - 1/x

	// denom
	// = C*x*x + C*x*d + y*d*d*Q
	// = x/d**2 + 1 / d + mark/C

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p

	const x = amm.baseAssetReserve;
	const y = amm.quoteAssetReserve;

	const d = amm.netBaseAssetAmount;
	const Q = amm.pegMultiplier;

	const C = cost.mul(new BN(-1));

	const numer1 = y.mul(d).mul(Q).div(AMM_RESERVE_PRECISION).div(PEG_PRECISION);
	const numer2 = C.mul(x.add(d)).div(QUOTE_PRECISION);
	const denom1 = C.mul(x)
		.mul(x.add(d))
		.div(AMM_RESERVE_PRECISION)
		.div(QUOTE_PRECISION);
	const denom2 = y
		.mul(d)
		.mul(d)
		.mul(Q)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(PEG_PRECISION);

	const numerator = d
		.mul(numer1.sub(numer2))
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	const denominator = denom1.add(denom2).div(AMM_TO_QUOTE_PRECISION_RATIO);

	return [numerator, denominator];
}

export function calculateBudgetedPeg(amm: AMM, cost: BN, targetPrice: BN): BN {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*y*d*Q)

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p
	const targetPeg = targetPrice
		.mul(amm.baseAssetReserve)
		.div(amm.quoteAssetReserve)
		.div(MARK_PRICE_PRECISION.div(PEG_PRECISION));

	const k = amm.sqrtK.mul(amm.sqrtK);
	const x = amm.baseAssetReserve;
	const y = amm.quoteAssetReserve;

	const d = amm.netBaseAssetAmount;
	const Q = amm.pegMultiplier;

	const C = cost.mul(new BN(-1));

	const deltaQuoteAssetReserves = y.sub(k.div(x.add(d)));
	const pegChangeDirection = targetPeg.sub(Q);

	const useTargetPeg =
		(deltaQuoteAssetReserves.lt(ZERO) && pegChangeDirection.gt(ZERO)) ||
		(deltaQuoteAssetReserves.gt(ZERO) && pegChangeDirection.lt(ZERO));

	if (deltaQuoteAssetReserves.eq(ZERO) || useTargetPeg) {
		return targetPeg;
	}

	const deltaPegMultiplier = C.mul(MARK_PRICE_PRECISION).div(
		deltaQuoteAssetReserves.div(AMM_TO_QUOTE_PRECISION_RATIO)
	);
	const newPeg = Q.sub(
		deltaPegMultiplier.mul(PEG_PRECISION).div(MARK_PRICE_PRECISION)
	);

	return newPeg;
}
