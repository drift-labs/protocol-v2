import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	ONE,
	QUOTE_PRECISION,
} from '../constants/numericConstants';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	MarketAccount,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import { squareRootBN, convertToNumber } from '..';

import { OraclePriceData } from '../oracles/types';
import {
	calculateRepegCost,
	calculateBudgetedK,
	calculateAdjustKCost,
	calculateBudgetedPeg,
} from './repeg';
export function calculatePrepeg(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN, BN, BN] {
	let pKNumer = new BN(1);
	let pKDenom = new BN(1);

	const targetPrice = oraclePriceData.price;
	let newPeg = targetPrice
		.mul(amm.baseAssetReserve)
		.div(amm.quoteAssetReserve)
		.div(MARK_PRICE_PRECISION.div(PEG_PRECISION));
	let prePegCost = calculateRepegCost(amm, newPeg);

	const totalFeeLB = amm.totalFee.div(new BN(2));
	const budget = BN.max(ZERO, amm.totalFeeMinusDistributions.sub(totalFeeLB));

	if (prePegCost > budget) {
		const deficit = budget.sub(prePegCost);
		[pKNumer, pKDenom] = calculateBudgetedK(amm, deficit);
		const deficitMadeup = calculateAdjustKCost(amm, pKNumer, pKDenom);
		prePegCost = budget.add(deficitMadeup);
		newPeg = calculateBudgetedPeg(amm, prePegCost, targetPrice);
	}
	console.log(
		'PREPEG RESULTS:',
		convertToNumber(prePegCost, QUOTE_PRECISION),
		pKNumer.toNumber(),
		pKDenom.toNumber(),
		newPeg.toNumber() / 1000
	);

	return [prePegCost, pKNumer, pKDenom, newPeg];
}

export function calculatePrepegAMM(
	amm: AMM,
	oraclePriceData: OraclePriceData
): AMM {
	const newAmm = Object.assign({}, amm);
	const [prepegCost, pKNumer, pkDenom, newPeg] = calculatePrepeg(
		amm,
		oraclePriceData
	);

	newAmm.baseAssetReserve = newAmm.baseAssetReserve.mul(pKNumer).div(pkDenom);
	newAmm.sqrtK = newAmm.sqrtK.mul(pKNumer).div(pkDenom);
	const invariant = newAmm.sqrtK.mul(newAmm.sqrtK);
	newAmm.quoteAssetReserve = invariant.div(newAmm.baseAssetReserve);
	newAmm.pegMultiplier = newPeg;

	newAmm.totalFeeMinusDistributions =
		newAmm.totalFeeMinusDistributions.sub(prepegCost);

	return newAmm;
}

export function calculatePrepegSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): { baseAssetReserve: BN; quoteAssetReserve: BN; newPeg: BN } {
	const newAmm = calculatePrepegAMM(amm, oraclePriceData);
	const dirReserves = calculateSpreadReserves(
		newAmm,
		direction,
		oraclePriceData
	);
	const result = {
		baseAssetReserve: dirReserves.baseAssetReserve,
		quoteAssetReserve: dirReserves.quoteAssetReserve,
		newPeg: newAmm.pegMultiplier,
	};

	return result;
}

export function calculateBidAskPrice(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN] {
	const newAmm = calculatePrepegAMM(amm, oraclePriceData);
	const askReserves = calculateSpreadReserves(
		newAmm,
		PositionDirection.LONG,
		oraclePriceData
	);
	const bidReserves = calculateSpreadReserves(
		newAmm,
		PositionDirection.LONG,
		oraclePriceData
	);

	const askPrice = calculatePrice(
		askReserves.baseAssetReserve,
		askReserves.quoteAssetReserve,
		newAmm.pegMultiplier
	);

	const bidPrice = calculatePrice(
		bidReserves.baseAssetReserve,
		bidReserves.quoteAssetReserve,
		newAmm.pegMultiplier
	);

	return [bidPrice, askPrice];
}

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
	amm: Pick<
		AMM,
		'pegMultiplier' | 'quoteAssetReserve' | 'sqrtK' | 'baseAssetReserve'
	>,
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

export function calculateSpread(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): number {
	let spread = amm.baseSpread;

	const markPrice = calculatePrice(
		amm.baseAssetReserve,
		amm.quoteAssetReserve,
		amm.pegMultiplier
	);

	const targetPrice = oraclePriceData.price;

	const targetMarkSpreadPct = markPrice
		.sub(targetPrice)
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(markPrice);

	// oracle retreat
	if (
		(isVariant(direction, 'long') && targetMarkSpreadPct.lt(ZERO)) ||
		(isVariant(direction, 'short') && targetMarkSpreadPct.gt(ZERO))
	) {
		spread = Math.max(spread, targetMarkSpreadPct.abs().toNumber());
	}

	// inventory skew
	const MAX_INVENTORY_SKEW = 20;
	if (
		(amm.netBaseAssetAmount.gt(ZERO) && isVariant(direction, 'long')) ||
		(amm.netBaseAssetAmount.lt(ZERO) && isVariant(direction, 'short'))
	) {
		const netCostBasis = amm.quoteAssetAmountLong
			.sub(amm.quoteAssetAmountShort)
			.abs();

		let effectiveLeverage = MAX_INVENTORY_SKEW;
		if (amm.totalFeeMinusDistributions.gt(ZERO)) {
			effectiveLeverage =
				netCostBasis.toNumber() / amm.totalFeeMinusDistributions.toNumber();
		}

		spread *= Math.min(MAX_INVENTORY_SKEW, Math.max(1, effectiveLeverage));
	}

	return spread;
}

export function calculateSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): {
	baseAssetReserve: BN;
	quoteAssetReserve: BN;
} {
	const spread = calculateSpread(amm, direction, oraclePriceData);

	if (spread === 0) {
		return {
			baseAssetReserve: amm.baseAssetReserve,
			quoteAssetReserve: amm.quoteAssetReserve,
		};
	}

	const quoteAsserReserveDelta = amm.quoteAssetReserve.div(
		BID_ASK_SPREAD_PRECISION.div(new BN(spread / 4))
	);

	let quoteAssetReserve;
	if (isVariant(direction, 'long')) {
		quoteAssetReserve = amm.quoteAssetReserve.add(quoteAsserReserveDelta);
	} else {
		quoteAssetReserve = amm.quoteAssetReserve.sub(quoteAsserReserveDelta);
	}

	const baseAssetReserve = amm.sqrtK.mul(amm.sqrtK).div(quoteAssetReserve);
	return {
		baseAssetReserve,
		quoteAssetReserve,
	};
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
export function calculateTerminalPrice(market: MarketAccount) {
	const directionToClose = market.amm.netBaseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.amm.netBaseAssetAmount.abs(),
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
	limit_price: BN,
	direction: PositionDirection,
	useSpread: boolean
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(MARK_PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(newBaseAssetReserveSquared);

	let baseAssetReserveBefore;
	if (useSpread) {
		baseAssetReserveBefore = calculateSpreadReserves(
			amm,
			direction
		).baseAssetReserve;
	} else {
		baseAssetReserveBefore = amm.baseAssetReserve;
	}

	if (newBaseAssetReserve.gt(baseAssetReserveBefore)) {
		return [
			newBaseAssetReserve.sub(baseAssetReserveBefore),
			PositionDirection.SHORT,
		];
	} else if (newBaseAssetReserve.lt(baseAssetReserveBefore)) {
		return [
			baseAssetReserveBefore.sub(newBaseAssetReserve),
			PositionDirection.LONG,
		];
	} else {
		console.log('tradeSize Too Small');
		return [new BN(0), PositionDirection.LONG];
	}
}

export function calculateQuoteAssetAmountSwapped(
	quoteAssetReserves: BN,
	pegMultiplier: BN,
	swapDirection: SwapDirection
): BN {
	let quoteAssetAmount = quoteAssetReserves
		.mul(pegMultiplier)
		.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

	if (isVariant(swapDirection, 'remove')) {
		quoteAssetAmount = quoteAssetAmount.add(ONE);
	}

	return quoteAssetAmount;
}
