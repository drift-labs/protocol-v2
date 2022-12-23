import { BN } from '@project-serum/anchor';
import { MarginCategory, SpotMarketAccount } from '../types';

export function castNumberToSpotPrecision(
	value: number,
	spotMarket: SpotMarketAccount
): BN {
	return new BN(value * Math.pow(10, spotMarket.decimals));
}

export function getSpotMarketMarginRatio(
	market: SpotMarketAccount,
	marginCategory: MarginCategory
): number {
	const liabilityWeight =
		(marginCategory == 'Initial'
			? market.initialLiabilityWeight
			: market.maintenanceLiabilityWeight) / 10000;
	return liabilityWeight - 1;
}
