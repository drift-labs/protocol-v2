import { BN } from '@project-serum/anchor';
import {
	MARK_PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	PEG_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { calculateBaseAssetValue } from './position';
import { calculateTerminalPrice } from './amm';

import { Market } from '../types';
import { calculatePositionPNL, calculateMarkPrice, convertToNumber } from '..';

/**
 * Helper function calculating adjust k cost
 * @param market
 * @param marketIndex
 * @param numerator
 * @param denomenator
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateAdjustKCost(
	market: Market,
	marketIndex: BN,
	numerator: BN,
	denomenator: BN
): BN {
	const netUserPosition = {
		baseAssetAmount: market.baseAssetAmount,
		lastCumulativeFundingRate: market.amm.cumulativeFundingRate,
		marketIndex: new BN(marketIndex),
		quoteAssetAmount: ZERO,
		openOrders: ZERO,
	};

	const currentValue = calculateBaseAssetValue(market, netUserPosition);

	const marketNewK = Object.assign({}, market);
	marketNewK.amm = Object.assign({}, market.amm);

	marketNewK.amm.baseAssetReserve = market.amm.baseAssetReserve
		.mul(numerator)
		.div(denomenator);
	marketNewK.amm.quoteAssetReserve = market.amm.quoteAssetReserve
		.mul(numerator)
		.div(denomenator);
	marketNewK.amm.sqrtK = market.amm.sqrtK.mul(numerator).div(denomenator);

	netUserPosition.quoteAssetAmount = currentValue;

	const cost = calculatePositionPNL(marketNewK, netUserPosition);

	return cost;
}

/**
 * Helper function calculating adjust pegMultiplier (repeg) cost
 *
 * @param market
 * @param marketIndex
 * @param newPeg
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateRepegCost(
	market: Market,
	marketIndex: BN,
	newPeg: BN
): BN {
	const netUserPosition = {
		baseAssetAmount: market.baseAssetAmount,
		lastCumulativeFundingRate: market.amm.cumulativeFundingRate,
		marketIndex: new BN(marketIndex),
		quoteAssetAmount: new BN(0),
		openOrders: ZERO,
	};

	const currentValue = calculateBaseAssetValue(market, netUserPosition);
	netUserPosition.quoteAssetAmount = currentValue;
	const prevMarketPrice = calculateMarkPrice(market);
	const marketNewPeg = Object.assign({}, market);
	marketNewPeg.amm = Object.assign({}, market.amm);

	// const marketNewPeg = JSON.parse(JSON.stringify(market));
	marketNewPeg.amm.pegMultiplier = newPeg;

	console.log(
		'Price moves from',
		convertToNumber(prevMarketPrice),
		'to',
		convertToNumber(calculateMarkPrice(marketNewPeg))
	);

	const cost = calculatePositionPNL(marketNewPeg, netUserPosition);

	return cost;
}

/**
 * Helper function calculating adjust pegMultiplier (repeg) cost
 *
 * @param market
 * @param marketIndex
 * @param newPeg
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateReserveRebalanceCost(
	market: Market,
	marketIndex: BN
): BN {
	const netUserPosition = {
		baseAssetAmount: market.baseAssetAmount,
		lastCumulativeFundingRate: market.amm.cumulativeFundingRate,
		marketIndex: new BN(marketIndex),
		quoteAssetAmount: new BN(0),
		openOrders: ZERO,
	};

	const currentValue = calculateBaseAssetValue(market, netUserPosition);
	netUserPosition.quoteAssetAmount = currentValue;
	const prevMarketPrice = calculateMarkPrice(market);
	const marketNewPeg = Object.assign({}, market);
	marketNewPeg.amm = Object.assign({}, market.amm);

	// const marketNewPeg = JSON.parse(JSON.stringify(market));
	const newPeg = calculateTerminalPrice(market)
		.mul(PEG_PRECISION)
		.div(MARK_PRICE_PRECISION);
	// const newPeg = prevMarketPrice.mul(PEG_PRECISION).div(MARK_PRICE_PRECISION);

	const newBaseReserve = market.amm.baseAssetReserve.add(
		market.baseAssetAmount
	);
	const newQuoteReserve = market.amm.sqrtK
		.mul(market.amm.sqrtK)
		.div(newBaseReserve);
	console.log(
		'current reserves on close, quote:',
		convertToNumber(newQuoteReserve, AMM_RESERVE_PRECISION),
		'base:',
		convertToNumber(newBaseReserve, AMM_RESERVE_PRECISION)
	);

	let newSqrtK;
	if (newPeg.lt(market.amm.pegMultiplier)) {
		newSqrtK = newBaseReserve;
	} else {
		newSqrtK = newQuoteReserve;
	}

	marketNewPeg.amm.baseAssetReserve = newSqrtK.sub(market.baseAssetAmount); // newSqrtK.sub(market.baseAssetAmount);
	marketNewPeg.amm.quoteAssetReserve = newSqrtK
		.mul(newSqrtK)
		.div(marketNewPeg.amm.baseAssetReserve);
	marketNewPeg.amm.sqrtK = newSqrtK;
	marketNewPeg.amm.pegMultiplier = newPeg;

	console.log(
		'Price moves from',
		convertToNumber(prevMarketPrice),
		'to',
		convertToNumber(calculateMarkPrice(marketNewPeg))
	);

	const cost = calculatePositionPNL(marketNewPeg, netUserPosition);

	return cost;
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
	const deltaPegMultiplier = C.mul(MARK_PRICE_PRECISION).div(
		deltaQuoteAssetReserves.div(AMM_TO_QUOTE_PRECISION_RATIO)
	);
	// .mul(PEG_PRECISION)
	// .div(QUOTE_PRECISION);
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
