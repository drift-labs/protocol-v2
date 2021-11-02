import { BN } from '@project-serum/anchor';
import { Market } from '../types';
import { calculatePrice } from './amm';

export function calculateBaseAssetPriceWithMantissa(market: Market): BN {
	return calculatePrice(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
}
