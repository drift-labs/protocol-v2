import {
	SpotMarketAccount,
	SpotBalanceType,
	isVariant,
	MarginCategory,
} from '../types';
import { BN } from '@project-serum/anchor';
import {
	SPOT_MARKET_UTILIZATION_PRECISION,
	ONE,
	TEN,
	ZERO,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	ONE_YEAR,
	AMM_RESERVE_PRECISION,
} from '../constants/numericConstants';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';
import { OraclePriceData } from '../oracles/types';
import { PERCENTAGE_PRECISION } from '../constants/numericConstants';

export function getBalance(
	tokenAmount: BN,
	spotMarket: SpotMarketAccount,
	balanceType: SpotBalanceType
): BN {
	const precisionIncrease = TEN.pow(new BN(19 - spotMarket.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? spotMarket.cumulativeDepositInterest
		: spotMarket.cumulativeBorrowInterest;

	let balance = tokenAmount.mul(precisionIncrease).div(cumulativeInterest);

	if (!balance.eq(ZERO) && isVariant(balanceType, 'borrow')) {
		balance = balance.add(ONE);
	}

	return balance;
}

export function getTokenAmount(
	balanceAmount: BN,
	spotMarket: SpotMarketAccount,
	balanceType: SpotBalanceType
): BN {
	const precisionDecrease = TEN.pow(new BN(19 - spotMarket.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? spotMarket.cumulativeDepositInterest
		: spotMarket.cumulativeBorrowInterest;

	return balanceAmount.mul(cumulativeInterest).div(precisionDecrease);
}

export function getSignedTokenAmount(
	tokenAmount: BN,
	balanceType: SpotBalanceType
): BN {
	if (isVariant(balanceType, 'deposit')) {
		return tokenAmount;
	} else {
		return tokenAmount.abs().neg();
	}
}

export function getTokenValue(
	tokenAmount: BN,
	spotDecimals: number,
	oraclePriceData: OraclePriceData
): BN {
	if (tokenAmount.eq(ZERO)) {
		return ZERO;
	}

	const precisionDecrease = TEN.pow(new BN(spotDecimals));

	return tokenAmount.mul(oraclePriceData.price).div(precisionDecrease);
}

export function calculateAssetWeight(
	balanceAmount: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory
): BN {
	const sizePrecision = TEN.pow(new BN(spotMarket.decimals));
	let sizeInAmmReservePrecision;
	if (sizePrecision.gt(AMM_RESERVE_PRECISION)) {
		sizeInAmmReservePrecision = balanceAmount.div(
			sizePrecision.div(AMM_RESERVE_PRECISION)
		);
	} else {
		sizeInAmmReservePrecision = balanceAmount
			.mul(AMM_RESERVE_PRECISION)
			.div(sizePrecision);
	}

	let assetWeight;

	switch (marginCategory) {
		case 'Initial':
			assetWeight = calculateSizeDiscountAssetWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.initialAssetWeight)
			);
			break;
		case 'Maintenance':
			assetWeight = new BN(spotMarket.maintenanceAssetWeight);
			break;
		default:
			assetWeight = new BN(spotMarket.initialAssetWeight);
			break;
	}

	return assetWeight;
}

export function calculateLiabilityWeight(
	balanceAmount: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory
): BN {
	const sizePrecision = TEN.pow(new BN(spotMarket.decimals));
	let sizeInAmmReservePrecision;
	if (sizePrecision.gt(AMM_RESERVE_PRECISION)) {
		sizeInAmmReservePrecision = balanceAmount.div(
			sizePrecision.div(AMM_RESERVE_PRECISION)
		);
	} else {
		sizeInAmmReservePrecision = balanceAmount
			.mul(AMM_RESERVE_PRECISION)
			.div(sizePrecision);
	}

	let assetWeight;

	switch (marginCategory) {
		case 'Initial':
			assetWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.initialLiabilityWeight),
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		case 'Maintenance':
			assetWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.maintenanceLiabilityWeight),
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		default:
			assetWeight = spotMarket.initialLiabilityWeight;
			break;
	}

	return assetWeight;
}

export function calculateUtilization(bank: SpotMarketAccount): BN {
	const tokenDepositAmount = getTokenAmount(
		bank.depositBalance,
		bank,
		SpotBalanceType.DEPOSIT
	);
	const tokenBorrowAmount = getTokenAmount(
		bank.borrowBalance,
		bank,
		SpotBalanceType.BORROW
	);

	let utilization: BN;
	if (tokenBorrowAmount.eq(ZERO) && tokenDepositAmount.eq(ZERO)) {
		utilization = ZERO;
	} else if (tokenDepositAmount.eq(ZERO)) {
		utilization = SPOT_MARKET_UTILIZATION_PRECISION;
	} else {
		utilization = tokenBorrowAmount
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(tokenDepositAmount);
	}

	return utilization;
}

export function calculateInterestRate(bank: SpotMarketAccount): BN {
	const utilization = calculateUtilization(bank);

	let interestRate: BN;
	if (utilization.gt(new BN(bank.optimalUtilization))) {
		const surplusUtilization = utilization.sub(new BN(bank.optimalUtilization));
		const borrowRateSlope = new BN(bank.maxBorrowRate - bank.optimalBorrowRate)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(
				SPOT_MARKET_UTILIZATION_PRECISION.sub(new BN(bank.optimalUtilization))
			);

		interestRate = new BN(bank.optimalBorrowRate).add(
			surplusUtilization
				.mul(borrowRateSlope)
				.div(SPOT_MARKET_UTILIZATION_PRECISION)
		);
	} else {
		const borrowRateSlope = new BN(bank.optimalBorrowRate)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(
				SPOT_MARKET_UTILIZATION_PRECISION.sub(new BN(bank.optimalUtilization))
			);

		interestRate = utilization
			.mul(borrowRateSlope)
			.div(SPOT_MARKET_UTILIZATION_PRECISION);
	}

	return interestRate;
}

export function calculateDepositRate(bank: SpotMarketAccount): BN {
	const utilization = calculateUtilization(bank);
	const borrowRate = calculateBorrowRate(bank);
	const depositRate = borrowRate
		.mul(PERCENTAGE_PRECISION.sub(new BN(bank.insuranceFund.totalFactor)))
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION)
		.div(PERCENTAGE_PRECISION);
	return depositRate;
}

export function calculateBorrowRate(bank: SpotMarketAccount): BN {
	return calculateInterestRate(bank);
}

export function calculateInterestAccumulated(
	bank: SpotMarketAccount,
	now: BN
): { borrowInterest: BN; depositInterest: BN } {
	const interestRate = calculateInterestRate(bank);

	const timeSinceLastUpdate = now.sub(bank.lastInterestTs);

	const modifiedBorrowRate = interestRate.mul(timeSinceLastUpdate);

	const utilization = calculateUtilization(bank);

	const modifiedDepositRate = modifiedBorrowRate
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION);

	const borrowInterest = bank.cumulativeBorrowInterest
		.mul(modifiedBorrowRate)
		.div(ONE_YEAR)
		.div(SPOT_MARKET_RATE_PRECISION)
		.add(ONE);
	const depositInterest = bank.cumulativeDepositInterest
		.mul(modifiedDepositRate)
		.div(ONE_YEAR)
		.div(SPOT_MARKET_RATE_PRECISION);

	return { borrowInterest, depositInterest };
}

export function calculateWithdrawLimit(
	spotMarket: SpotMarketAccount,
	now: BN
): {
	borrowLimit: BN;
	withdrawLimit: BN;
	minDepositAmount: BN;
	maxBorrowAmount: BN;
	currentDepositAmount;
	currentBorrowAmount;
} {
	const marketDepositTokenAmount = getTokenAmount(
		spotMarket.depositBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	const marketBorrowTokenAmount = getTokenAmount(
		spotMarket.borrowBalance,
		spotMarket,
		SpotBalanceType.BORROW
	);

	const twentyFourHours = new BN(60 * 60 * 24);
	const sinceLast = now.sub(spotMarket.lastTwapTs);
	const sinceStart = BN.max(ZERO, twentyFourHours.sub(sinceLast));
	const borrowTokenTwapLive = spotMarket.borrowTokenTwap
		.mul(sinceStart)
		.add(marketBorrowTokenAmount.mul(sinceLast))
		.div(sinceLast.add(sinceStart));

	const depositTokenTwapLive = spotMarket.depositTokenTwap
		.mul(sinceStart)
		.add(marketDepositTokenAmount.mul(sinceLast))
		.div(sinceLast.add(sinceStart));

	const maxBorrowTokens = BN.min(
		BN.max(
			marketDepositTokenAmount.div(new BN(6)),
			borrowTokenTwapLive.add(borrowTokenTwapLive.div(new BN(5)))
		),
		marketDepositTokenAmount.sub(marketDepositTokenAmount.div(new BN(5)))
	); // between ~15-80% utilization with friction on twap

	const minDepositTokens = depositTokenTwapLive.sub(
		BN.min(
			BN.max(
				depositTokenTwapLive.div(new BN(5)),
				spotMarket.withdrawGuardThreshold
			),
			depositTokenTwapLive
		)
	);

	let withdrawLimit = BN.max(
		marketDepositTokenAmount.sub(minDepositTokens),
		ZERO
	);

	let borrowLimit = BN.max(maxBorrowTokens.sub(marketBorrowTokenAmount), ZERO);

	if (borrowLimit.eq(ZERO)) {
		withdrawLimit = ZERO;
	}

	if (withdrawLimit.eq(ZERO)) {
		borrowLimit = ZERO;
	}

	return {
		borrowLimit,
		withdrawLimit,
		maxBorrowAmount: maxBorrowTokens,
		minDepositAmount: minDepositTokens,
		currentDepositAmount: marketDepositTokenAmount,
		currentBorrowAmount: marketBorrowTokenAmount,
	};
}
