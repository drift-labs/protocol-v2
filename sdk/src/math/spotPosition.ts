import { MarginCategory, SpotMarketAccount, SpotPosition } from '../types';
import {
	QUOTE_SPOT_MARKET_INDEX,
	SPOT_MARKET_WEIGHT_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';
import {
	calculateAssetWeight,
	calculateLiabilityWeight,
	getSignedTokenAmount,
	getStrictTokenValue,
	getTokenAmount,
	getTokenValue,
} from './spotBalance';
import { StrictOraclePrice } from '../oracles/strictOraclePrice';

export function isSpotPositionAvailable(position: SpotPosition): boolean {
	return position.scaledBalance.eq(ZERO) && position.openOrders === 0;
}

export type OrderFillSimulation = {
	tokenAmount: BN;
	ordersValue: BN;
	tokenValue: BN;
	weight: BN;
	weightedTokenValue: BN;
	freeCollateralContribution;
};

export function getWorstCaseTokenAmounts(
	spotPosition: SpotPosition,
	spotMarketAccount: SpotMarketAccount,
	strictOraclePrice: StrictOraclePrice,
	marginCategory: MarginCategory,
	customMarginRatio?: number
): OrderFillSimulation {
	const tokenAmount = getSignedTokenAmount(
		getTokenAmount(
			spotPosition.scaledBalance,
			spotMarketAccount,
			spotPosition.balanceType
		),
		spotPosition.balanceType
	);

	const tokenValue = getStrictTokenValue(
		tokenAmount,
		spotMarketAccount.decimals,
		strictOraclePrice
	);

	if (spotPosition.openBids.eq(ZERO) && spotPosition.openAsks.eq(ZERO)) {
		const { weight, weightedTokenValue } = calculateWeightedTokenValue(
			tokenAmount,
			tokenValue,
			strictOraclePrice.current,
			spotMarketAccount,
			marginCategory,
			customMarginRatio
		);
		return {
			tokenAmount,
			ordersValue: ZERO,
			tokenValue,
			weight,
			weightedTokenValue,
			freeCollateralContribution: weightedTokenValue,
		};
	}

	const bidsSimulation = simulateOrderFill(
		tokenAmount,
		tokenValue,
		spotPosition.openBids,
		strictOraclePrice,
		spotMarketAccount,
		marginCategory,
		customMarginRatio
	);
	const asksSimulation = simulateOrderFill(
		tokenAmount,
		tokenValue,
		spotPosition.openAsks,
		strictOraclePrice,
		spotMarketAccount,
		marginCategory,
		customMarginRatio
	);

	if (
		asksSimulation.freeCollateralContribution.lt(
			bidsSimulation.freeCollateralContribution
		)
	) {
		return asksSimulation;
	} else {
		return bidsSimulation;
	}
}

export function calculateWeightedTokenValue(
	tokenAmount: BN,
	tokenValue: BN,
	oraclePrice: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory,
	customMarginRatio?: number
): { weight: BN; weightedTokenValue: BN } {
	let weight: BN;
	if (tokenValue.gte(ZERO)) {
		weight = calculateAssetWeight(
			tokenAmount,
			oraclePrice,
			spotMarket,
			marginCategory
		);
	} else {
		weight = calculateLiabilityWeight(
			tokenAmount.abs(),
			spotMarket,
			marginCategory
		);
	}

	if (
		marginCategory === 'Initial' &&
		customMarginRatio &&
		spotMarket.marketIndex !== QUOTE_SPOT_MARKET_INDEX
	) {
		const userCustomAssetWeight = tokenValue.gte(ZERO)
			? BN.max(ZERO, SPOT_MARKET_WEIGHT_PRECISION.subn(customMarginRatio))
			: SPOT_MARKET_WEIGHT_PRECISION.addn(customMarginRatio);

		weight = tokenValue.gte(ZERO)
			? BN.min(weight, userCustomAssetWeight)
			: BN.max(weight, userCustomAssetWeight);
	}

	return {
		weight: weight,
		weightedTokenValue: tokenValue
			.mul(weight)
			.div(SPOT_MARKET_WEIGHT_PRECISION),
	};
}

export function simulateOrderFill(
	tokenAmount: BN,
	tokenValue: BN,
	openOrders: BN,
	strictOraclePrice: StrictOraclePrice,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory,
	customMarginRatio?: number
): OrderFillSimulation {
	const ordersValue = getTokenValue(openOrders.neg(), spotMarket.decimals, {
		price: strictOraclePrice.max(),
	});
	const tokenAmountAfterFill = tokenAmount.add(openOrders);
	const tokenValueAfterFill = tokenValue.add(ordersValue.neg());

	const { weight, weightedTokenValue: weightedTokenValueAfterFill } =
		calculateWeightedTokenValue(
			tokenAmountAfterFill,
			tokenValueAfterFill,
			strictOraclePrice.current,
			spotMarket,
			marginCategory,
			customMarginRatio
		);

	const freeCollateralContribution =
		weightedTokenValueAfterFill.add(ordersValue);

	return {
		tokenAmount: tokenAmountAfterFill,
		ordersValue: ordersValue,
		tokenValue: tokenValueAfterFill,
		weight,
		weightedTokenValue: weightedTokenValueAfterFill,
		freeCollateralContribution,
	};
}
