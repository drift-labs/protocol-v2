import { BN } from '@project-serum/anchor';
import { Market } from '../types';
import { calculateCurvePriceWithMantissa } from './amm';

export function calculateBaseAssetPriceWithMantissa(market: Market): BN {
	return calculateCurvePriceWithMantissa(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
}
