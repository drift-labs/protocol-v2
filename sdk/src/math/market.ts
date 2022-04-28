import { BN } from '@project-serum/anchor';
import { Market, PositionDirection } from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	calculateSpreadReserves,
	getSwapDirection,
} from './amm';
import { OraclePriceData } from '../oracles/types';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateMarkPrice(market: Market): BN {
	return calculatePrice(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
}

/**
 * Calculates market bid price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateBidPrice(market: Market): BN {
	const { baseAssetReserve, quoteAssetReserve } = calculateSpreadReserves(
		market.amm,
		PositionDirection.SHORT
	);

	return calculatePrice(
		baseAssetReserve,
		quoteAssetReserve,
		market.amm.pegMultiplier
	);
}

/**
 * Calculates market ask price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateAskPrice(market: Market): BN {
	const { baseAssetReserve, quoteAssetReserve } = calculateSpreadReserves(
		market.amm,
		PositionDirection.LONG
	);

	return calculatePrice(
		baseAssetReserve,
		quoteAssetReserve,
		market.amm.pegMultiplier
	);
}

export function calculateNewMarketAfterTrade(
	baseAssetAmount: BN,
	direction: PositionDirection,
	market: Market
): Market {
	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			baseAssetAmount.abs(),
			getSwapDirection('base', direction)
		);

	const newAmm = Object.assign({}, market.amm);
	const newMarket = Object.assign({}, market);
	newMarket.amm = newAmm;
	newMarket.amm.quoteAssetReserve = newQuoteAssetReserve;
	newMarket.amm.baseAssetReserve = newBaseAssetReserve;

	return newMarket;
}

export function calculateMarkOracleSpread(
	market: Market,
	oraclePriceData: OraclePriceData
): BN {
	const markPrice = calculateMarkPrice(market);
	return calculateOracleSpread(markPrice, oraclePriceData);
}

export function calculateOracleSpread(
	price: BN,
	oraclePriceData: OraclePriceData
): BN {
	return price.sub(oraclePriceData.price);
}
