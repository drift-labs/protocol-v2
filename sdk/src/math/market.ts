import { BN } from '@project-serum/anchor';
import { Market } from '../types';
import { calculatePrice } from './amm';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice precision 10^10
 */
export function calculateMarkPrice(market: Market): BN {
	return calculatePrice(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
}
