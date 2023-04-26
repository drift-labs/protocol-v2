import { BN } from '@coral-xyz/anchor';
import {
	isVariant,
	MarginCategory,
	SpotBalanceType,
	SpotMarketAccount,
} from '../types';
import { calculateAssetWeight, calculateLiabilityWeight } from './spotBalance';
import { MARGIN_PRECISION } from '../constants/numericConstants';

export function castNumberToSpotPrecision(
	value: number,
	spotMarket: SpotMarketAccount
): BN {
	return new BN(value * Math.pow(10, spotMarket.decimals));
}

export function calculateSpotMarketMarginRatio(
	market: SpotMarketAccount,
	marginCategory: MarginCategory,
	size: BN,
	balanceType: SpotBalanceType
): number {
	if (isVariant(balanceType, 'deposit')) {
		const assetWeight = calculateAssetWeight(size, market, marginCategory);
		return MARGIN_PRECISION.sub(assetWeight).toNumber();
	} else {
		const liabilityWeight = calculateLiabilityWeight(
			size,
			market,
			marginCategory
		);
		return liabilityWeight.sub(MARGIN_PRECISION).toNumber();
	}
}
