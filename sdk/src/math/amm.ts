import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	PEG_PRECISION,
	ZERO,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
} from '../constants/numericConstants';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	Market,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import { squareRootBN } from '..';

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetAmount
 * @param quoteAssetAmount
 * @param peg_multiplier
 * @returns price : Precision MARK_PRICE_PRECISION
 */
export function calculatePrice(
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg_multiplier: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetAmount
		.mul(MARK_PRICE_PRECISION)
		.mul(peg_multiplier)
		.div(PEG_PRECISION)
		.div(baseAssetAmount);
}

export type AssetType = 'quote' | 'base';

/**
 * Calculates what the amm reserves would be after swapping a quote or base asset amount.
 *
 * @param amm
 * @param inputAssetType
 * @param swapAmount
 * @param swapDirection
 * @returns quoteAssetReserve and baseAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateAmmReservesAfterSwap(
	amm: AMM,
	inputAssetType: AssetType,
	swapAmount: BN,
	swapDirection: SwapDirection
): [BN, BN] {
	assert(swapAmount.gte(ZERO), 'swapAmount must be greater than 0');

	let newQuoteAssetReserve;
	let newBaseAssetReserve;

	if (inputAssetType === 'quote') {
		swapAmount = swapAmount
			.mul(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
			.div(amm.pegMultiplier);

		[newQuoteAssetReserve, newBaseAssetReserve] = calculateSwapOutput(
			amm.quoteAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	} else {
		[newBaseAssetReserve, newQuoteAssetReserve] = calculateSwapOutput(
			amm.baseAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	}

	return [newQuoteAssetReserve, newBaseAssetReserve];
}

/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutput(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	const newOutputAssetReserve = invariant.div(newInputAssetReserve);
	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Translate long/shorting quote/base asset into amm operation
 *
 * @param inputAssetType
 * @param positionDirection
 */
export function getSwapDirection(
	inputAssetType: AssetType,
	positionDirection: PositionDirection
): SwapDirection {
	if (isVariant(positionDirection, 'long') && inputAssetType === 'base') {
		return SwapDirection.REMOVE;
	}

	if (isVariant(positionDirection, 'short') && inputAssetType === 'quote') {
		return SwapDirection.REMOVE;
	}

	return SwapDirection.ADD;
}

/**
 * Helper function calculating terminal price of amm
 *
 * @param market
 * @returns cost : Precision MARK_PRICE_PRECISION
 */
export function calculateTerminalPrice(market: Market) {
	const directionToClose = market.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.baseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);

	const terminalPrice = newQuoteAssetReserve
		.mul(MARK_PRICE_PRECISION)
		.mul(market.amm.pegMultiplier)
		.div(PEG_PRECISION)
		.div(newBaseAssetReserve);

	return terminalPrice;
}

export function calculateMaxBaseAssetAmountToTrade(
	amm: AMM,
	limit_price: BN
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(MARK_PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(newBaseAssetReserveSquared);

	if (newBaseAssetReserve.gt(amm.baseAssetReserve)) {
		return [
			newBaseAssetReserve.sub(amm.baseAssetReserve),
			PositionDirection.SHORT,
		];
	} else if (newBaseAssetReserve.lt(amm.baseAssetReserve)) {
		return [
			amm.baseAssetReserve.sub(newBaseAssetReserve),
			PositionDirection.LONG,
		];
	} else {
		console.log('tradeSize Too Small');
		return [new BN(0), PositionDirection.LONG];
	}
}

export function calculateBudgetedK(market: Market, cost: BN): [BN, BN] {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*y*d*Q)

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p

	// const k = market.amm.sqrtK.mul(market.amm.sqrtK);
	const x = market.amm.baseAssetReserve;
	const y = market.amm.quoteAssetReserve;

	const d = market.baseAssetAmount;
	const Q = market.amm.pegMultiplier;

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
		.mul(numer1.add(numer2))
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	const denominator = denom1
		.add(denom2)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	console.log(numerator, denominator);
	// const p = (numerator).div(denominator);

	// const formulaCost = (numer21.sub(numer20).sub(numer1)).mul(market.amm.pegMultiplier).div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
	// console.log(convertToNumber(formulaCost, QUOTE_PRECISION))

	return [numerator, denominator];
}

export function calculateBudgetedPeg(market: Market, cost: BN): BN {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*y*d*Q)

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p

	const k = market.amm.sqrtK.mul(market.amm.sqrtK);
	const x = market.amm.baseAssetReserve;
	const y = market.amm.quoteAssetReserve;

	const d = market.baseAssetAmount;
	const Q = market.amm.pegMultiplier;

	const C = cost.mul(new BN(-1));

	const deltaQuoteAssetReserves = y.sub(k.div(x.add(d)));
	const deltaPegMultiplier = C.mul(MARK_PRICE_PRECISION)
		.div(deltaQuoteAssetReserves.div(AMM_TO_QUOTE_PRECISION_RATIO))
		.mul(PEG_PRECISION)
		.div(QUOTE_PRECISION);
	console.log(
		Q.toNumber(),
		'change by',
		deltaPegMultiplier.toNumber() / MARK_PRICE_PRECISION.toNumber()
	);
	const newPeg = Q.sub(
		deltaPegMultiplier.mul(PEG_PRECISION).div(MARK_PRICE_PRECISION)
	);

	return newPeg;
}
