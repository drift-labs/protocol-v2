import { BN } from '@project-serum/anchor';
import { SpotMarketAccount } from '../types';

export function castNumberToSpotPrecision(
	value: number,
	spotMarket: SpotMarketAccount
): BN {
	return new BN(value * Math.pow(10, spotMarket.decimals));
}
