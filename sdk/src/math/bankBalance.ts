import {
	isVariant,
	MarginCategory,
	SpotBalanceType,
	SpotMarketAccount,
} from '../types';
import { BN } from '@project-serum/anchor';
import {
	ONE,
	TEN,
	ZERO,
	ONE_YEAR,
	AMM_RESERVE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_UTILIZATION_PRECISION,
	SPOT_MARKET_INTEREST_PRECISION,
} from '../constants/numericConstants';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';

export function getBalance(
	tokenAmount: BN,
	bank: SpotMarketAccount,
	balanceType: SpotBalanceType
): BN {
	const precisionIncrease = TEN.pow(new BN(16 - bank.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? bank.cumulativeDepositInterest
		: bank.cumulativeBorrowInterest;

	let balance = tokenAmount.mul(precisionIncrease).div(cumulativeInterest);

	if (!balance.eq(ZERO) && isVariant(balanceType, 'borrow')) {
		balance = balance.add(ONE);
	}

	return balance;
}

export function getTokenAmount(
	balanceAmount: BN,
	bank: SpotMarketAccount,
	balanceType: SpotBalanceType
): BN {
	const precisionDecrease = TEN.pow(new BN(16 - bank.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? bank.cumulativeDepositInterest
		: bank.cumulativeBorrowInterest;

	return balanceAmount.mul(cumulativeInterest).div(precisionDecrease);
}

export function calculateAssetWeight(
	balanceAmount: BN,
	bank: SpotMarketAccount,
	marginCategory: MarginCategory
): BN {
	const sizePrecision = TEN.pow(new BN(bank.decimals));
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
				bank.imfFactor,
				bank.initialAssetWeight
			);
			break;
		case 'Maintenance':
			assetWeight = calculateSizeDiscountAssetWeight(
				sizeInAmmReservePrecision,
				bank.imfFactor,
				bank.maintenanceAssetWeight
			);
			break;
		default:
			assetWeight = bank.initialAssetWeight;
			break;
	}

	return assetWeight;
}

export function calculateLiabilityWeight(
	balanceAmount: BN,
	bank: SpotMarketAccount,
	marginCategory: MarginCategory
): BN {
	const sizePrecision = TEN.pow(new BN(bank.decimals));
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
				bank.imfFactor,
				bank.initialLiabilityWeight,
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		case 'Maintenance':
			assetWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				bank.imfFactor,
				bank.maintenanceLiabilityWeight,
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		default:
			assetWeight = bank.initialLiabilityWeight;
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
	if (utilization.gt(bank.optimalUtilization)) {
		const surplusUtilization = utilization.sub(bank.optimalUtilization);
		const borrowRateSlope = bank.maxBorrowRate
			.sub(bank.optimalBorrowRate)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(SPOT_MARKET_UTILIZATION_PRECISION.sub(bank.optimalUtilization));

		interestRate = bank.optimalBorrowRate.add(
			surplusUtilization
				.mul(borrowRateSlope)
				.div(SPOT_MARKET_UTILIZATION_PRECISION)
		);
	} else {
		const borrowRateSlope = bank.optimalBorrowRate
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(SPOT_MARKET_UTILIZATION_PRECISION.sub(bank.optimalUtilization));

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
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION);
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
		.div(SPOT_MARKET_INTEREST_PRECISION)
		.add(ONE);
	const depositInterest = bank.cumulativeDepositInterest
		.mul(modifiedDepositRate)
		.div(ONE_YEAR)
		.div(SPOT_MARKET_INTEREST_PRECISION);

	return { borrowInterest, depositInterest };
}

export function calculateWithdrawLimit(
	bank: SpotMarketAccount,
	now: BN
): { borrowLimit: BN; withdrawLimit: BN } {
	const bankDepositTokenAmount = getTokenAmount(
		bank.depositBalance,
		bank,
		SpotBalanceType.DEPOSIT
	);
	const bankBorrowTokenAmount = getTokenAmount(
		bank.borrowBalance,
		bank,
		SpotBalanceType.BORROW
	);

	const twentyFourHours = new BN(60 * 60 * 24);
	const sinceLast = now.sub(bank.lastTwapTs);
	const sinceStart = BN.max(ZERO, twentyFourHours.sub(sinceLast));
	const borrowTokenTwapLive = bank.borrowTokenTwap
		.mul(sinceStart)
		.add(bankBorrowTokenAmount.mul(sinceLast))
		.div(sinceLast.add(sinceLast));

	const depositTokenTwapLive = bank.depositTokenTwap
		.mul(sinceStart)
		.add(bankDepositTokenAmount.mul(sinceLast))
		.div(sinceLast.add(sinceLast));

	const maxBorrowTokens = BN.min(
		BN.max(
			bankDepositTokenAmount.div(new BN(6)),
			borrowTokenTwapLive.add(borrowTokenTwapLive.div(new BN(5)))
		),
		bankDepositTokenAmount.sub(bankDepositTokenAmount.div(new BN(10)))
	); // between ~15-90% utilization with friction on twap

	const minDepositTokens = depositTokenTwapLive.sub(
		BN.min(
			BN.max(depositTokenTwapLive.div(new BN(5)), bank.withdrawGuardThreshold),
			depositTokenTwapLive
		)
	);

	return {
		borrowLimit: maxBorrowTokens.sub(bankBorrowTokenAmount),
		withdrawLimit: bankDepositTokenAmount.sub(minDepositTokens),
	};
}
