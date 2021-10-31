import { BN } from '@project-serum/anchor';
import { Market } from '../types';
import { calculateCurvePriceWithMantissa } from './amm';
import { AMM_MANTISSA } from '../clearingHouse';

export function calculateBaseAssetPriceWithMantissa(market: Market): BN {
	return calculateCurvePriceWithMantissa(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
}

export function calculateBaseAssetPriceAsNumber(market: Market): number {
	return (
		calculateBaseAssetPriceWithMantissa(market).toNumber() /
		AMM_MANTISSA.toNumber()
	);
}
