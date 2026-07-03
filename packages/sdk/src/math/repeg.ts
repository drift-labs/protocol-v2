import { BN } from '../isomorphic/anchor';
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
 * Closed-form estimate of the quote-denominated cost of scaling the AMM's `sqrtK`
 * (liquidity depth) by `numerator / denomenator` while holding `pegMultiplier` fixed.
 * Used by `calculateNewAmm` as the cheap-to-compute stand-in for the program's K-shrink
 * step (`adjust_k_cost_and_update` in `vlp/amm/quoter.rs`, which shrinks `sqrtK` by 0.1%
 * — i.e. `numerator`/`denomenator` = 999/1000 — when a straight repeg to the oracle price
 * would exceed the AMM's affordability budget). A positive result is a cost the AMM must
 * fund from `totalFeeMinusDistributions`; shrinking K (denomenator > numerator) typically
 * yields a negative cost (a rebate) since it reduces the AMM's net unrealized exposure.
 * @param amm AMM state (uses `baseAssetReserve`, `quoteAssetReserve`, `baseAssetAmountWithAmm`, `pegMultiplier`).
 * @param numerator Numerator of the K scale factor (e.g. 999).
 * @param denomenator Denominator of the K scale factor (e.g. 1000).
 * @returns Cost of the K adjustment, QUOTE_PRECISION (1e6).
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
 * Calculates the quote-denominated cost of moving the AMM's `pegMultiplier` to `newPeg`,
 * mirroring `calculate_repeg_cost` in `vlp/amm/math/repeg.rs`: `(quoteAssetReserve -
 * terminalQuoteAssetReserve) * (newPeg - pegMultiplier) / AMM_TO_QUOTE_PRECISION_RATIO`.
 * The sign follows the AMM's inventory skew (`quoteAssetReserve - terminalQuoteAssetReserve`)
 * — repegging in the direction that favors the AMM's current net position is free or a
 * rebate; repegging against it costs `totalFeeMinusDistributions`. Zero when the AMM carries
 * no net inventory (`quoteAssetReserve == terminalQuoteAssetReserve`).
 * @param amm AMM state (uses `quoteAssetReserve`, `terminalQuoteAssetReserve`, `pegMultiplier`).
 * @param newPeg Candidate peg multiplier, PEG_PRECISION (1e6).
 * @returns Signed cost of the repeg, QUOTE_PRECISION (1e6).
 */
export function calculateRepegCost(amm: AMM, newPeg: BN): BN {
	const dqar = amm.quoteAssetReserve.sub(amm.terminalQuoteAssetReserve);
	const cost = dqar
		.mul(newPeg.sub(amm.pegMultiplier))
		.div(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(PEG_PRECISION);
	return cost;
}

/**
 * Solves for a `sqrtK` scale factor `numerator / denominator` such that repegging the AMM
 * to price-neutral (holding the terminal/reserve price relationship implied by the current
 * inventory) costs exactly `budget`. Used as the closed-form companion to
 * `calculateAdjustKCost` (same K-shrink mechanism as the program's `adjust_k_cost_and_update`)
 * when solving for "how much must K move to spend exactly this much." Falls back to a fixed
 * `[10000, 1]` (10000x factor) if the budget is negative (protocol spending to increase K) and the
 * solution would be numerically unstable.
 * @param x AMM `baseAssetReserve`, AMM_RESERVE_PRECISION (1e9).
 * @param y AMM `quoteAssetReserve`, AMM_RESERVE_PRECISION (1e9).
 * @param budget Quote budget available to spend on the K adjustment, QUOTE_PRECISION (1e6).
 * @param Q AMM `pegMultiplier`, PEG_PRECISION (1e6).
 * @param d AMM `baseAssetAmountWithAmm` (net AMM inventory), AMM_RESERVE_PRECISION (1e9).
 * @returns `[numerator, denominator]` scale factor to apply to `sqrtK`/`baseAssetReserve`.
 */
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

/**
 * Calculates the largest peg move affordable within `budget`, capped so it never overshoots
 * `targetPrice`'s implied peg. Mirrors the "use full budget peg" branch of `adjust_amm` in
 * `vlp/amm/math/repeg.rs`: computes a per-peg-unit cost from the AMM's inventory skew, then
 * returns `targetPeg` directly whenever moving toward it is free or revenue-generating
 * (`useTargetPeg`), otherwise walks the peg by `budget / perPegCost` and floors it at 1.
 * @param amm AMM state (uses `quoteAssetReserve`, `terminalQuoteAssetReserve`, `baseAssetReserve`, `pegMultiplier`).
 * @param budget Quote budget available to spend on the repeg, QUOTE_PRECISION (1e6).
 * @param targetPrice Oracle-implied target price driving the optimal peg, PRICE_PRECISION (1e6).
 * @returns New peg multiplier, PEG_PRECISION (1e6), never below 1.
 */
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
