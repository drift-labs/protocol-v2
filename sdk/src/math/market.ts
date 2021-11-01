import { BN } from '@project-serum/anchor';
import { Market } from '../types';
import { calculateCurvePriceWithMantissa } from './amm';
import { AMM_MANTISSA } from '../constants/numericConstants';

export function calculateBaseAssetPriceWithMantissa(market: Market): BN {
	return calculateCurvePriceWithMantissa(
		market.amm.baseAssetReserve,
		market.amm.quoteAssetReserve,
		market.amm.pegMultiplier
	);
}

export function calculateBaseAssetPriceAsNumber(market: Market): number {
	const baseAssetPrice = calculateBaseAssetPriceWithMantissa(market);

	return (
		baseAssetPrice.div(AMM_MANTISSA).toNumber() +
		baseAssetPrice.mod(AMM_MANTISSA).toNumber() / AMM_MANTISSA.toNumber()
	);
}
