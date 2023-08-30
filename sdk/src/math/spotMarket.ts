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
	value: number | BN,
	spotMarket: SpotMarketAccount
): BN {
	if (typeof value === 'number') {
		return new BN(value * Math.pow(10, spotMarket.decimals));
	} else {
		return value.mul(new BN(Math.pow(10, spotMarket.decimals)));
	}
}

export function calculateSpotMarketMarginRatio(
	market: SpotMarketAccount,
	oraclePrice: BN,
	marginCategory: MarginCategory,
	size: BN,
	balanceType: SpotBalanceType
): number {
	if (isVariant(balanceType, 'deposit')) {
		const assetWeight = calculateAssetWeight(
			size,
			oraclePrice,
			market,
			marginCategory
		);
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
