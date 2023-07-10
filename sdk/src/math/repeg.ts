import { BN } from '@coral-xyz/anchor';
import { assert } from '../assert/assert';
import {
	PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	PEG_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	PRICE_DIV_PEG,
	QUOTE_PRECISION,
	ZERO,
	ONE,
	PERCENTAGE_PRECISION,
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

	const d = amm.baseAssetAmountWithAmm;
	const Q = amm.pegMultiplier;

	const quoteScale = y.mul(d).mul(Q); //.div(AMM_RESERVE_PRECISION);

	const p = numerator.mul(PRICE_PRECISION).div(denomenator);

	const cost = quoteScale
		.mul(PERCENTAGE_PRECISION)
		.mul(PERCENTAGE_PRECISION)
		.div(x.add(d))
		.sub(
			quoteScale
				.mul(p)
				.mul(PERCENTAGE_PRECISION)
				.mul(PERCENTAGE_PRECISION)
				.div(PRICE_PRECISION)
				.div(x.mul(p).div(PRICE_PRECISION).add(d))
		)
		.div(PERCENTAGE_PRECISION)
		.div(PERCENTAGE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(PEG_PRECISION);

	return cost.mul(new BN(-1));
}

// /**
//  * Helper function calculating adjust k cost
//  * @param amm
//  * @param numerator
//  * @param denomenator
//  * @returns cost : Precision QUOTE_ASSET_PRECISION
//  */
// export function calculateAdjustKCost2(
// 	amm: AMM,
// 	numerator: BN,
// 	denomenator: BN
// ): BN {
// 	// const k = market.amm.sqrtK.mul(market.amm.sqrtK);
// 	const directionToClose = amm.baseAssetAmountWithAmm.gt(ZERO)
// 		? PositionDirection.SHORT
// 		: PositionDirection.LONG;

// 	const [newQuoteAssetReserve, _newBaseAssetReserve] =
// 		calculateAmmReservesAfterSwap(
// 			amm,
// 			'base',
// 			amm.baseAssetAmountWithAmm.abs(),
// 			getSwapDirection('base', directionToClose)
// 		);
// }

/**
 * Helper function calculating adjust pegMultiplier (repeg) cost
 *
 * @param amm
 * @param newPeg
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateRepegCost(amm: AMM, newPeg: BN): BN {
	const dqar = amm.quoteAssetReserve.sub(amm.terminalQuoteAssetReserve);
	const cost = dqar
		.mul(newPeg.sub(amm.pegMultiplier))
		.div(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(PEG_PRECISION);
	return cost;
}

export function calculateBudgetedKBN(
	x: BN,
	y: BN,
	budget: BN,
	Q: BN,
	d: BN
): [BN, BN] {
	assert(Q.gt(new BN(0)));
	const C = budget.mul(new BN(-1));

	let dSign = new BN(1);
	if (d.lt(new BN(0))) {
		dSign = new BN(-1);
	}
	const pegged_y_d_d = y
		.mul(d)
		.mul(d)
		.mul(Q)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(PEG_PRECISION);

	const numer1 = pegged_y_d_d;
	const numer2 = C.mul(d)
		.div(QUOTE_PRECISION)
		.mul(x.add(d))
		.div(AMM_RESERVE_PRECISION)
		.mul(dSign);

	const denom1 = C.mul(x)
		.mul(x.add(d))
		.div(AMM_RESERVE_PRECISION)
		.div(QUOTE_PRECISION);
	const denom2 = pegged_y_d_d;

	// protocol is spending to increase k
	if (C.lt(ZERO)) {
		// thus denom1 is negative and solution is unstable
		if (denom1.abs().gt(denom2.abs())) {
			console.log('denom1 > denom2', denom1.toString(), denom2.toString());
			console.log('budget cost exceeds stable K solution');
			return [new BN(10000), new BN(1)];
		}
	}

	const numerator = numer1.sub(numer2).div(AMM_TO_QUOTE_PRECISION_RATIO);
	const denominator = denom1.add(denom2).div(AMM_TO_QUOTE_PRECISION_RATIO);

	return [numerator, denominator];
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

	const d = amm.baseAssetAmountWithAmm;
	const Q = amm.pegMultiplier;

	const [numerator, denominator] = calculateBudgetedKBN(x, y, cost, Q, d);

	return [numerator, denominator];
}

export function calculateBudgetedPeg(
	amm: AMM,
	budget: BN,
	targetPrice: BN
): BN {
	let perPegCost = amm.quoteAssetReserve
		.sub(amm.terminalQuoteAssetReserve)
		.div(AMM_RESERVE_PRECISION.div(PRICE_PRECISION));

	if (perPegCost.gt(ZERO)) {
		perPegCost = perPegCost.add(ONE);
	} else if (perPegCost.lt(ZERO)) {
		perPegCost = perPegCost.sub(ONE);
	}

	const targetPeg = targetPrice
		.mul(amm.baseAssetReserve)
		.div(amm.quoteAssetReserve)
		.div(PRICE_DIV_PEG);

	const pegChangeDirection = targetPeg.sub(amm.pegMultiplier);

	const useTargetPeg =
		(perPegCost.lt(ZERO) && pegChangeDirection.gt(ZERO)) ||
		(perPegCost.gt(ZERO) && pegChangeDirection.lt(ZERO));

	if (perPegCost.eq(ZERO) || useTargetPeg) {
		return targetPeg;
	}

	const budgetDeltaPeg = budget.mul(PEG_PRECISION).div(perPegCost);
	const newPeg = BN.max(ONE, amm.pegMultiplier.add(budgetDeltaPeg));

	return newPeg;
}
