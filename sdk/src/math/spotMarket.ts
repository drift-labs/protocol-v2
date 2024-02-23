import { BN } from '@coral-xyz/anchor';
import {
	isVariant,
	MarginCategory,
	SpotBalanceType,
	SpotMarketAccount,
} from '../types';
import { calculateAssetWeight, calculateLiabilityWeight } from './spotBalance';
import { MARGIN_PRECISION } from '../constants/numericConstants';
import { numberToSafeBN } from './utils';

export function castNumberToSpotPrecision(
	value: number | BN,
	spotMarket: SpotMarketAccount
): BN {
	if (typeof value === 'number') {
		return numberToSafeBN(value, new BN(Math.pow(10, spotMarket.decimals)));
	} else {
		return value.mul(new BN(Math.pow(10, spotMarket.decimals)));
	}
}

export function calculateSpotMarketMarginRatio(
	market: SpotMarketAccount,
	oraclePrice: BN,
	marginCategory: MarginCategory,
	size: BN,
	balanceType: SpotBalanceType,
	customMarginRatio = 0
): number {
	let marginRatio;

	if (isVariant(balanceType, 'deposit')) {
		const assetWeight = calculateAssetWeight(
			size,
			oraclePrice,
			market,
			marginCategory
		);
		marginRatio = MARGIN_PRECISION.sub(assetWeight).toNumber();
	} else {
		const liabilityWeight = calculateLiabilityWeight(
			size,
			market,
			marginCategory
		);
		marginRatio = liabilityWeight.sub(MARGIN_PRECISION).toNumber();
	}

	if (marginCategory === 'Initial') {
		// use lowest leverage between max allowed and optional user custom max
		return Math.max(marginRatio, customMarginRatio);
	}

	return marginRatio;
}
