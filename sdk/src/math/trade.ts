import { Market, PositionDirection } from '../types';
import { BN } from '@project-serum/anchor';
import { assert } from '../assert/assert';
import {
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
} from '../constants/numericConstants';
import { calculateMarkPrice } from './market';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	getSwapDirection,
} from './amm';
import { squareRootBN } from '../utils';

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
	| 'acquiredQuoteAssetAmount';

/**
 * Calculates avg/max slippage (price impact) for candidate trade
 * @param direction
 * @param amount
 * @param market
 * @return
 * 	| 'pctAvgSlippage' =>  the percentage change to entryPrice (average est slippage in execution) : BN
 * 	| 'pctMaxSlippage' =>  the percentage change to maxPrice (highest est slippage in execution) : BN
 */
export function calculateTradeSlippage(
	direction: PositionDirection,
	amount: BN,
	market: Market
): [BN, BN, BN, BN] {
	const oldPrice = calculateMarkPrice(market);
	if (amount.eq(ZERO)) {
		return [ZERO, ZERO, oldPrice, oldPrice];
	}
	const [acquiredBase, acquiredQuote] = calculateTradeAcquiredAmounts(
		direction,
		amount,
		market
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
 * 	| 'acquiredBase' =>  positive/negative change in user's base : BN
 * 	| 'acquiredQuote' => positive/negative change in user's quote : BN
 */
export function calculateTradeAcquiredAmounts(
	direction: PositionDirection,
	amount: BN,
	market: Market
): [BN, BN] {
	if (amount.eq(ZERO)) {
		return [ZERO, ZERO];
	}

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'quote',
			amount,
			getSwapDirection('quote', direction)
		);

	const acquiredBase = market.amm.baseAssetReserve.sub(newBaseAssetReserve);
	const acquiredQuote = market.amm.quoteAssetReserve.sub(newQuoteAssetReserve);

	return [acquiredBase, acquiredQuote];
}

/**
 * calculateTargetPriceTrade
 * simple function for finding arbitraging trades
 * @param market
 * @param targetPrice
 * @param pct optional default is 100% gap filling, can set smaller.
 * @returns trade direction/size in order to push price to a targetPrice
 */
export function calculateTargetPriceTrade(
	market: Market,
	targetPrice: BN,
	pct: BN = MAXPCT
): [PositionDirection, BN, BN, BN] {
	assert(market.amm.baseAssetReserve.gt(ZERO));
	assert(targetPrice.gt(ZERO));
	assert(pct.lte(MAXPCT) && pct.gt(ZERO));

	const markPriceWithMantissa = calculateMarkPrice(market);

	if (targetPrice.gt(markPriceWithMantissa)) {
		const priceGap = targetPrice.sub(markPriceWithMantissa);
		const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
		targetPrice = markPriceWithMantissa.add(priceGapScaled);
	} else {
		const priceGap = markPriceWithMantissa.sub(targetPrice);
		const priceGapScaled = priceGap.mul(pct).div(MAXPCT);
		targetPrice = markPriceWithMantissa.sub(priceGapScaled);
	}

	let direction;
	let tradeSize;
	let baseSize;

	const x1 = market.amm.baseAssetReserve;
	const y1 = market.amm.quoteAssetReserve;
	const peg = market.amm.pegMultiplier;
	const invariant = market.amm.sqrtK.mul(market.amm.sqrtK);
	const k = invariant.mul(MARK_PRICE_PRECISION);

	let x2;
	let y2;
	const biasModifer = new BN(1);
	let targetPriceCalced;

	if (markPriceWithMantissa.gt(targetPrice)) {
		// overestimate y2, todo Math.sqrt
		x2 = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_PRECISION).sub(biasModifer)
		).sub(new BN(1));
		y2 = k.div(MARK_PRICE_PRECISION).div(x2);

		targetPriceCalced = calculatePrice(x2, y2, peg);
		direction = PositionDirection.SHORT;
		tradeSize = y1
			.sub(y2)
			.mul(peg)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);
		baseSize = x1.sub(x2);
	} else if (markPriceWithMantissa.lt(targetPrice)) {
		// underestimate y2, todo Math.sqrt
		x2 = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_PRECISION).add(biasModifer)
		).add(new BN(1));
		y2 = k.div(MARK_PRICE_PRECISION).div(x2);

		targetPriceCalced = calculatePrice(x2, y2, peg);

		direction = PositionDirection.LONG;
		tradeSize = y2
			.sub(y1)
			.mul(peg)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);
		baseSize = x2.sub(x1);
	} else {
		// no trade, market is at target
		direction = PositionDirection.LONG;
		tradeSize = ZERO;
		baseSize = ZERO;
		return [direction, tradeSize, targetPrice, targetPrice];
	}

	let tp1 = targetPrice;
	let tp2 = targetPriceCalced;
	let ogDiff = targetPrice.sub(markPriceWithMantissa);

	if (direction == PositionDirection.SHORT) {
		tp1 = targetPriceCalced;
		tp2 = targetPrice;
		ogDiff = markPriceWithMantissa.sub(targetPrice);
	}

	const entryPrice = calculatePrice(
		baseSize.abs(),
		tradeSize,
		MARK_PRICE_PRECISION
	);
	assert(tp1.sub(tp2).lte(ogDiff), 'Target Price Calculation incorrect');
	// assert(tp1.sub(tp2).lt(MARK_PRICE_PRECISION), 'Target Price Calculation incorrect'); //  super OoB shorts do not
	assert(
		tp2.lte(tp1) || tp2.sub(tp1).abs() < 100000,
		'Target Price Calculation incorrect' +
			tp2.toString() +
			'>=' +
			tp1.toString() +
			'err: ' +
			tp2.sub(tp1).abs().toString()
	); //todo

	return [direction, tradeSize, entryPrice, targetPrice];
}
