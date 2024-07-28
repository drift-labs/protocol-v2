import { BN } from '@coral-xyz/anchor';
import {
	isVariant,
	MarginCategory,
	SpotBalanceType,
	SpotMarketAccount,
} from '../types';
import { calculateAssetWeight, calculateLiabilityWeight, getTokenAmount } from './spotBalance';
import { MARGIN_PRECISION } from '../constants/numericConstants';
import { numberToSafeBN } from './utils';
import { BN_MAX, PublicKey, ZERO } from '@drift-labs/sdk';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

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

export function calculateMaxRemainingDeposit(
	market: SpotMarketAccount
) {
	let marketMaxTokenDeposits = market.maxTokenDeposits;

	if (marketMaxTokenDeposits.eq(ZERO)) {
		// If the maxTokenDeposits is set to zero then that means there is no limit. Return the largest number we can to represent infinite available deposit.
		marketMaxTokenDeposits = BN_MAX;
		return marketMaxTokenDeposits;
	}

	const totalDepositsTokenAmount = getTokenAmount(
		market.depositBalance,
		market,
		SpotBalanceType.DEPOSIT
	);

	return marketMaxTokenDeposits.sub(totalDepositsTokenAmount);
}

export function getTokenProgramForSpotMarket(
	spotMarketAccount: SpotMarketAccount
): PublicKey {
	if (spotMarketAccount.tokenProgram === 1) {
		return TOKEN_2022_PROGRAM_ID;
	}
	return TOKEN_PROGRAM_ID;
}