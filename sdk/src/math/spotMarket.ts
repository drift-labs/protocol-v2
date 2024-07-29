import { BN } from '@coral-xyz/anchor';
import {
	isVariant,
	MarginCategory,
	SpotBalanceType,
	SpotMarketAccount,
} from '../types';
import {
	calculateAssetWeight,
	calculateLiabilityWeight,
	getTokenAmount,
} from './spotBalance';
import { MARGIN_PRECISION, ZERO } from '../constants/numericConstants';
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

/**
 * Returns the maximum remaining deposit that can be made to the spot market. If the maxTokenDeposits on the market is zero then there is no limit and this function will also return zero. (so that needs to be checked)
 * @param market
 * @returns
 */
export function calculateMaxRemainingDeposit(market: SpotMarketAccount) {
	const marketMaxTokenDeposits = market.maxTokenDeposits;

	if (marketMaxTokenDeposits.eq(ZERO)) {
		// If the maxTokenDeposits is set to zero then that means there is no limit. Return the largest number we can to represent infinite available deposit.
		return ZERO;
	}

	const totalDepositsTokenAmount = getTokenAmount(
		market.depositBalance,
		market,
		SpotBalanceType.DEPOSIT
	);

	return marketMaxTokenDeposits.sub(totalDepositsTokenAmount);
}
