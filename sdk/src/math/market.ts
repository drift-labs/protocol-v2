import { BN } from '@project-serum/anchor';
import { MarketAccount, PositionDirection } from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	// calculateSpreadReserves,
	calculatePrepegSpreadReserves,
	getSwapDirection,
	calculatePrepegAMM,
} from './amm';
import { OraclePriceData } from '../oracles/types';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateMarkPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const newAmm = calculatePrepegAMM(market.amm, oraclePriceData);
	return calculatePrice(
		newAmm.baseAssetReserve,
		newAmm.quoteAssetReserve,
		newAmm.pegMultiplier
	);
}

/**
 * Calculates market bid price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateBidPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculatePrepegSpreadReserves(
			market.amm,
			PositionDirection.SHORT,
			oraclePriceData
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

/**
 * Calculates market ask price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateAskPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const { baseAssetReserve, quoteAssetReserve, _sqrtK, newPeg } =
		calculatePrepegSpreadReserves(
			market.amm,
			PositionDirection.LONG,
			oraclePriceData
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

export function calculateNewMarketAfterTrade(
	baseAssetAmount: BN,
	direction: PositionDirection,
	market: MarketAccount
): MarketAccount {
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
	market: MarketAccount,
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
