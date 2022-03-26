import { BN } from '@project-serum/anchor';
import { Market, PositionDirection } from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
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
	return markPrice.sub(oraclePriceData.price);
}
