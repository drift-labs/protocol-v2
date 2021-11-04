import { Market, PositionDirection } from '../types';
import { BN } from '@project-serum/anchor';
import { assert } from '../assert/assert';
import {
	MARK_PRICE_PRECISION,
	PEG_SCALAR,
	QUOTE_BASE_PRECISION_DIFF,
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
 * Calculates various types of price impact statistics
 * @param direction
 * @param amount
 * @param market
 * @param unit
 * 	| 'entryPrice' => the average price a user gets the position at : BN
 * 	| 'maxPrice' =>  the price that the market is moved to after the trade : BN
 * 	| 'priceDelta' =>  the change in price (with MANTISSA) : BN
 * 	| 'priceDeltaAsNumber' =>  the change in price (as number, no MANTISSA) : number
 * 	| 'pctAvg' =>  the percentage change from entryPrice (average est slippage in execution) : BN
 * 	| 'pctMax' =>  the percentage change to maxPrice (highest est slippage in execution) : BN
 * 	| 'quoteAssetAmount' => the amount of quote paid (~amount w/ slight rounding?) : BN
 * 	| 'quoteAssetAmountPeg' => the amount of quotePeg paid (quote/pegMultiplier) : BN
 */
export function calculatePriceImpact(
	direction: PositionDirection,
	amount: BN,
	market: Market,
	unit?: PriceImpactUnit
) {
	if (amount.eq(new BN(0))) {
		return new BN(0);
	}
	const oldPrice = calculateMarkPrice(market);

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'quote',
			amount,
			getSwapDirection('quote', direction)
		);

	if (unit == 'acquiredBaseAssetAmount') {
		return market.amm.baseAssetReserve.sub(newBaseAssetReserve);
	}
	if (unit == 'acquiredQuoteAssetAmount') {
		return market.amm.quoteAssetReserve.sub(newQuoteAssetReserve);
	}

	const entryPrice = calculatePrice(
		market.amm.baseAssetReserve.sub(newBaseAssetReserve),
		market.amm.quoteAssetReserve.sub(newQuoteAssetReserve),
		market.amm.pegMultiplier
	).mul(new BN(-1));

	if (entryPrice.eq(new BN(0))) {
		return new BN(0);
	}

	if (unit == 'entryPrice') {
		return entryPrice;
	}

	const newPrice = calculatePrice(
		newBaseAssetReserve,
		newQuoteAssetReserve,
		market.amm.pegMultiplier
	);

	if (unit == 'maxPrice') {
		return newPrice;
	}

	if (oldPrice == newPrice) {
		throw new Error('insufficient `amount` passed:');
	}

	let slippage;
	if (newPrice.gt(oldPrice)) {
		assert(direction == PositionDirection.LONG);
		if (unit == 'pctMax') {
			slippage = newPrice.sub(oldPrice).mul(MARK_PRICE_PRECISION).div(oldPrice);
		} else if (unit == 'pctAvg') {
			slippage = entryPrice
				.sub(oldPrice)
				.mul(MARK_PRICE_PRECISION)
				.div(oldPrice);
		} else if (
			[
				'priceDelta',
				'quoteAssetAmount',
				'quoteAssetAmountPeg',
				'priceDeltaAsNumber',
			].includes(unit)
		) {
			slippage = newPrice.sub(oldPrice);
		}
	} else {
		assert(direction == PositionDirection.SHORT);
		if (unit == 'pctMax') {
			slippage = oldPrice.sub(newPrice).mul(MARK_PRICE_PRECISION).div(oldPrice);
		} else if (unit == 'pctAvg') {
			slippage = oldPrice
				.sub(entryPrice)
				.mul(MARK_PRICE_PRECISION)
				.div(oldPrice);
		} else if (
			[
				'priceDelta',
				'quoteAssetAmount',
				'quoteAssetAmountPeg',
				'priceDeltaAsNumber',
			].includes(unit)
		) {
			slippage = oldPrice.sub(newPrice);
		}
	}
	if (unit == 'quoteAssetAmount') {
		slippage = slippage.mul(amount);
	} else if (unit == 'quoteAssetAmountPeg') {
		slippage = slippage.mul(amount).div(market.amm.pegMultiplier);
	} else if (unit == 'priceDeltaAsNumber') {
		slippage = slippage.toNumber() / MARK_PRICE_PRECISION.toNumber();
	}

	return slippage;
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
			k.div(targetPrice).mul(peg).div(PEG_SCALAR).sub(biasModifer)
		).sub(new BN(1));
		y2 = k.div(MARK_PRICE_PRECISION).div(x2);

		targetPriceCalced = calculatePrice(x2, y2, peg);
		direction = PositionDirection.SHORT;
		tradeSize = y1
			.sub(y2)
			.mul(peg)
			.div(PEG_SCALAR)
			.div(QUOTE_BASE_PRECISION_DIFF);
		baseSize = x1.sub(x2);
	} else if (markPriceWithMantissa.lt(targetPrice)) {
		// underestimate y2, todo Math.sqrt
		x2 = squareRootBN(
			k.div(targetPrice).mul(peg).div(PEG_SCALAR).add(biasModifer)
		).add(new BN(1));
		y2 = k.div(MARK_PRICE_PRECISION).div(x2);

		targetPriceCalced = calculatePrice(x2, y2, peg);

		direction = PositionDirection.LONG;
		tradeSize = y2
			.sub(y1)
			.mul(peg)
			.div(PEG_SCALAR)
			.div(QUOTE_BASE_PRECISION_DIFF);
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
