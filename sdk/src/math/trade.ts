import { isVariant, Market, PositionDirection } from '../types';
import { BN } from '@project-serum/anchor';
import { assert } from '../assert/assert';
import {
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
	ONE,
} from '../constants/numericConstants';
import { calculateMarkPrice } from './market';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	getSwapDirection,
	AssetType,
} from './amm';
import { squareRootBN } from './utils';

const MAXPCT = new BN(1000); //percentage units are [0,1000] => [0,1]

export type PriceImpactUnit =
	| 'entryPrice'
	| 'maxPrice'
	| 'priceDelta'
	| 'priceDeltaAsNumber'
	| 'pctAvg'
	| 'pctMax'
	| 'quoteAssetAmount'
	| 'quoteAssetAmountPeg'
	| 'acquiredBaseAssetAmount'
	| 'acquiredQuoteAssetAmount'
	| 'all';

/**
 * Calculates avg/max slippage (price impact) for candidate trade
 * @param direction
 * @param amount
 * @param market
 * @return [pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice]
 *
 * 'pctAvgSlippage' =>  the percentage change to entryPrice (average est slippage in execution) : Precision MARK_PRICE_PRECISION
 *
 * 'pctMaxSlippage' =>  the percentage change to maxPrice (highest est slippage in execution) : Precision MARK_PRICE_PRECISION
 *
 * 'entryPrice' => the average price of the trade : Precision MARK_PRICE_PRECISION
 *
 * 'newPrice' => the price of the asset after the trade : Precision MARK_PRICE_PRECISION
 */
export function calculateTradeSlippage(
	direction: PositionDirection,
	amount: BN,
	market: Market,
	inputAssetType: AssetType = 'quote'
): [BN, BN, BN, BN] {
	const oldPrice = calculateMarkPrice(market);
	if (amount.eq(ZERO)) {
		return [ZERO, ZERO, oldPrice, oldPrice];
	}
	const [acquiredBase, acquiredQuote] = calculateTradeAcquiredAmounts(
		direction,
		amount,
		market,
		inputAssetType
	);

	const entryPrice = calculatePrice(
		acquiredBase,
		acquiredQuote,
		market.amm.pegMultiplier
	).mul(new BN(-1));

	const newPrice = calculatePrice(
		market.amm.baseAssetReserve.sub(acquiredBase),
		market.amm.quoteAssetReserve.sub(acquiredQuote),
		market.amm.pegMultiplier
	);

	if (direction == PositionDirection.SHORT) {
		assert(newPrice.lt(oldPrice));
	} else {
		assert(oldPrice.lt(newPrice));
	}

	const pctMaxSlippage = newPrice
		.sub(oldPrice)
		.mul(MARK_PRICE_PRECISION)
		.div(oldPrice)
		.abs();
	const pctAvgSlippage = entryPrice
		.sub(oldPrice)
		.mul(MARK_PRICE_PRECISION)
		.div(oldPrice)
		.abs();

	return [pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice];
}

/**
 * Calculates acquired amounts for trade executed
 * @param direction
 * @param amount
 * @param market
 * @return
 * 	| 'acquiredBase' =>  positive/negative change in user's base : BN TODO-PRECISION
 * 	| 'acquiredQuote' => positive/negative change in user's quote : BN TODO-PRECISION
 */
export function calculateTradeAcquiredAmounts(
	direction: PositionDirection,
	amount: BN,
	market: Market,
	inputAssetType: AssetType = 'quote'
): [BN, BN] {
	if (amount.eq(ZERO)) {
		return [ZERO, ZERO];
	}

	const swapDirection = getSwapDirection(inputAssetType, direction);
	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			inputAssetType,
			amount,
			swapDirection
		);

	const acquiredBase = market.amm.baseAssetReserve.sub(newBaseAssetReserve);
	let acquiredQuote = market.amm.quoteAssetReserve.sub(newQuoteAssetReserve);
	if (inputAssetType === 'base' && isVariant(swapDirection, 'remove')) {
		acquiredQuote = acquiredQuote.sub(ONE);
	}

	return [acquiredBase, acquiredQuote];
}

/**
 * calculateTargetPriceTrade
 * simple function for finding arbitraging trades
 * @param market
 * @param targetPrice
 * @param pct optional default is 100% gap filling, can set smaller.
 * @returns trade direction/size in order to push price to a targetPrice,
 *
 * [
 *   direction => direction of trade required, TODO-PRECISION
 *   tradeSize => size of trade required, TODO-PRECISION
 *   entryPrice => the entry price for the trade, TODO-PRECISION
 *   targetPrice => the target price TODO-PRECISION
 * ]
 */
export function calculateTargetPriceTrade(
	market: Market,
	targetPrice: BN,
	pct: BN = MAXPCT,
	outputAssetType: AssetType = 'quote'
): [PositionDirection, BN, BN, BN] {
	assert(market.amm.baseAssetReserve.gt(ZERO));
	assert(targetPrice.gt(ZERO));
	assert(pct.lte(MAXPCT) && pct.gt(ZERO));

	const markPriceBefore = calculateMarkPrice(market);

	if (targetPrice.gt(markPriceBefore)) {
		const priceGap = targetPrice.sub(markPriceBefore);
		const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
		targetPrice = markPriceBefore.add(priceGapScaled);
	} else {
		const priceGap = markPriceBefore.sub(targetPrice);
		const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
		targetPrice = markPriceBefore.sub(priceGapScaled);
	}

	let direction;
	let tradeSize;
	let baseSize;

	const baseAssetReserveBefore = market.amm.baseAssetReserve;
	const quoteAssetReserveBefore = market.amm.quoteAssetReserve;
	const peg = market.amm.pegMultiplier;
	const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);
	const k = invariant.mul(MARK_PRICE_PRECISION);

	let baseAssetReserveAfter;
	let quoteAssetReserveAfter;
	const biasModifier = new BN(1);
	let markPriceAfter;

	if (markPriceBefore.gt(targetPrice)) {
		// overestimate y2
		baseAssetReserveAfter = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_PRECISION).sub(biasModifier)
		).sub(new BN(1));
		quoteAssetReserveAfter = k
			.div(MARK_PRICE_PRECISION)
			.div(baseAssetReserveAfter);

		markPriceAfter = calculatePrice(
			baseAssetReserveAfter,
			quoteAssetReserveAfter,
			peg
		);
		direction = PositionDirection.SHORT;
		tradeSize = quoteAssetReserveBefore
			.sub(quoteAssetReserveAfter)
			.mul(peg)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);
		baseSize = baseAssetReserveAfter.sub(baseAssetReserveBefore);
	} else if (markPriceBefore.lt(targetPrice)) {
		// underestimate y2
		baseAssetReserveAfter = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_PRECISION).add(biasModifier)
		).add(new BN(1));
		quoteAssetReserveAfter = k
			.div(MARK_PRICE_PRECISION)
			.div(baseAssetReserveAfter);

		markPriceAfter = calculatePrice(
			baseAssetReserveAfter,
			quoteAssetReserveAfter,
			peg
		);

		direction = PositionDirection.LONG;
		tradeSize = quoteAssetReserveAfter
			.sub(quoteAssetReserveBefore)
			.mul(peg)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);
		baseSize = baseAssetReserveBefore.sub(baseAssetReserveAfter);
	} else {
		// no trade, market is at target
		direction = PositionDirection.LONG;
		tradeSize = ZERO;
		return [direction, tradeSize, targetPrice, targetPrice];
	}

	let tp1 = targetPrice;
	let tp2 = markPriceAfter;
	let originalDiff = targetPrice.sub(markPriceBefore);

	if (direction == PositionDirection.SHORT) {
		tp1 = markPriceAfter;
		tp2 = targetPrice;
		originalDiff = markPriceBefore.sub(targetPrice);
	}

	const entryPrice = tradeSize
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.mul(MARK_PRICE_PRECISION)
		.div(baseSize.abs());

	assert(tp1.sub(tp2).lte(originalDiff), 'Target Price Calculation incorrect');
	assert(
		tp2.lte(tp1) || tp2.sub(tp1).abs() < 100000,
		'Target Price Calculation incorrect' +
			tp2.toString() +
			'>=' +
			tp1.toString() +
			'err: ' +
			tp2.sub(tp1).abs().toString()
	);
	if (outputAssetType == 'quote') {
		return [direction, tradeSize, entryPrice, targetPrice];
	} else {
		return [direction, baseSize, entryPrice, targetPrice];
	}
}
