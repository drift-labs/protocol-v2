import { MarginCategory, SpotMarketAccount, SpotPosition } from '../types';
import {
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
import { OraclePriceData } from '../oracles/types';

export function isSpotPositionAvailable(position: SpotPosition): boolean {
	return position.scaledBalance.eq(ZERO) && position.openOrders === 0;
}

export type OrderFillSimulation = {
	tokenAmount: BN;
	ordersValue: BN;
	tokenValue: BN;
	weightedTokenValue: BN;
	freeCollateralContribution;
};

export function getWorstCaseTokenAmounts(
	spotPosition: SpotPosition,
	spotMarketAccount: SpotMarketAccount,
	oraclePriceData: OraclePriceData,
	marginCategory: MarginCategory
): OrderFillSimulation {
	const tokenAmount = getSignedTokenAmount(
		getTokenAmount(
			spotPosition.scaledBalance,
			spotMarketAccount,
			spotPosition.balanceType
		),
		spotPosition.balanceType
	);

	let tokenValue;
	if (marginCategory === 'Maintenance') {
		tokenValue = getTokenValue(
			tokenAmount,
			spotMarketAccount.decimals,
			oraclePriceData
		);
	} else {
		const twap = spotMarketAccount.historicalOracleData.lastOraclePriceTwap5Min;
		tokenValue = getStrictTokenValue(
			tokenAmount,
			spotMarketAccount.decimals,
			oraclePriceData,
			twap
		);
	}

	if (spotPosition.openBids.eq(ZERO) && spotPosition.openAsks.eq(ZERO)) {
		const weightedTokenValue = calculateWeightedTokenValue(
			tokenAmount,
			tokenValue,
			oraclePriceData.price,
			spotMarketAccount,
			marginCategory
		);
		return {
			tokenAmount,
			ordersValue: ZERO,
			tokenValue,
			weightedTokenValue,
			freeCollateralContribution: weightedTokenValue,
		};
	}

	const bidsSimulation = simulateOrderFill(
		tokenAmount,
		tokenValue,
		spotPosition.openBids,
		oraclePriceData.price,
		spotMarketAccount,
		marginCategory
	);
	const asksSimulation = simulateOrderFill(
		tokenAmount,
		tokenValue,
		spotPosition.openAsks,
		oraclePriceData.price,
		spotMarketAccount,
		marginCategory
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
	marginCategory: MarginCategory
): BN {
	if (tokenValue.gte(ZERO)) {
		const weight = calculateAssetWeight(
			tokenAmount,
			oraclePrice,
			spotMarket,
			marginCategory
		);

		return tokenValue.mul(weight).div(SPOT_MARKET_WEIGHT_PRECISION);
	} else {
		const weight = calculateLiabilityWeight(
			tokenAmount,
			spotMarket,
			marginCategory
		);

		return tokenValue.mul(weight).div(SPOT_MARKET_WEIGHT_PRECISION);
	}
}

export function simulateOrderFill(
	tokenAmount: BN,
	tokenValue: BN,
	openOrders: BN,
	oraclePrice: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory
): OrderFillSimulation {
	const maxOraclePrice = BN.max(
		spotMarket.historicalOracleData.lastOraclePriceTwap5Min
	);
	const ordersValue = getTokenValue(openOrders.neg(), spotMarket.decimals, {
		price: maxOraclePrice,
	});
	const tokenAmountAfterFill = tokenAmount.add(ordersValue);
	const tokenValueAfterFill = tokenValue.add(ordersValue.neg());

	const weightedTokenValueAfterFill = calculateWeightedTokenValue(
		tokenAmountAfterFill,
		tokenValueAfterFill,
		oraclePrice,
		spotMarket,
		marginCategory
	);

	const freeCollateralContribution =
		weightedTokenValueAfterFill.add(ordersValue);

	return {
		tokenAmount: tokenAmountAfterFill,
		ordersValue: ordersValue,
		tokenValue: tokenValueAfterFill,
		weightedTokenValue: weightedTokenValueAfterFill,
		freeCollateralContribution,
	};
}
