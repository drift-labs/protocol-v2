import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { calculateBaseAssetValue } from './position';
import { AMM, PositionDirection, SwapDirection, Market } from '../types';
import { assert } from '../assert/assert';
import { calculatePositionPNL, calculateMarkPrice, convertToNumber } from '..';

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
	if (
		positionDirection === PositionDirection.LONG &&
		inputAssetType === 'base'
	) {
		return SwapDirection.REMOVE;
	}

	if (
		positionDirection === PositionDirection.SHORT &&
		inputAssetType === 'quote'
	) {
		return SwapDirection.REMOVE;
	}

	return SwapDirection.ADD;
}

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
		quoteAssetAmount: new BN(0),
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
 * Helper function calculating terminal price of amm
 *
 * @param market
 * @returns cost : Precision MARK_PRICE_PRECISION
 */
export function calculateTerminalPrice(market: Market) {
	if (!market.initialized) {
		return new BN(0);
	}

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
