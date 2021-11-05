import { BN } from '@project-serum/anchor';
import { Market } from '../types';
import { calculatePrice } from './amm';

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
