import {
	BankAccount,
	BankBalanceType,
	isVariant,
	MarginCategory,
} from '../types';
import { BN } from '@project-serum/anchor';
import {
	BANK_UTILIZATION_PRECISION,
	ONE,
	TEN,
	ZERO,
	BANK_INTEREST_PRECISION,
	BANK_WEIGHT_PRECISION,
	ONE_YEAR,
	AMM_RESERVE_PRECISION,
} from '../constants/numericConstants';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';

export function getBalance(
	tokenAmount: BN,
	bank: BankAccount,
	balanceType: BankBalanceType
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
	bank: BankAccount,
	balanceType: BankBalanceType
): BN {
	const precisionDecrease = TEN.pow(new BN(16 - bank.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? bank.cumulativeDepositInterest
		: bank.cumulativeBorrowInterest;

	return balanceAmount.mul(cumulativeInterest).div(precisionDecrease);
}

export function calculateAssetWeight(
	balanceAmount: BN,
	bank: BankAccount,
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
	bank: BankAccount,
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
				BANK_WEIGHT_PRECISION
			);
			break;
		case 'Maintenance':
			assetWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				bank.imfFactor,
				bank.maintenanceLiabilityWeight,
				BANK_WEIGHT_PRECISION
			);
			break;
		default:
			assetWeight = bank.initialLiabilityWeight;
			break;
	}

	return assetWeight;
}

export function calculateInterestAccumulated(
	bank: BankAccount,
	now: BN
): { borrowInterest: BN; depositInterest: BN } {
	const token_deposit_amount = getTokenAmount(
		bank.depositBalance,
		bank,
		BankBalanceType.DEPOSIT
	);
	const token_borrow_amount = getTokenAmount(
		bank.borrowBalance,
		bank,
		BankBalanceType.BORROW
	);

	let utilization: BN;
	if (token_borrow_amount.eq(ZERO) && token_deposit_amount.eq(ZERO)) {
		utilization = ZERO;
	} else if (token_deposit_amount.eq(ZERO)) {
		utilization = BANK_UTILIZATION_PRECISION;
	} else {
		utilization = token_borrow_amount
			.mul(BANK_UTILIZATION_PRECISION)
			.div(token_deposit_amount);
	}

	let interest_rate: BN;
	if (utilization.gt(bank.optimalUtilization)) {
		const surplusUtilization = utilization.sub(bank.optimalUtilization);
		const borrowRateSlope = bank.maxBorrowRate
			.sub(bank.optimalBorrowRate)
			.mul(BANK_UTILIZATION_PRECISION)
			.div(BANK_UTILIZATION_PRECISION.sub(bank.optimalUtilization));

		interest_rate = bank.optimalBorrowRate.add(
			surplusUtilization.mul(borrowRateSlope).div(BANK_UTILIZATION_PRECISION)
		);
	} else {
		const borrowRateSlope = bank.optimalBorrowRate
			.mul(BANK_UTILIZATION_PRECISION)
			.div(BANK_UTILIZATION_PRECISION.sub(bank.optimalUtilization));

		interest_rate = utilization
			.mul(borrowRateSlope)
			.div(BANK_UTILIZATION_PRECISION);
	}

	const timeSinceLastUpdate = now.sub(bank.lastUpdated);

	const modifiedBorrowRate = interest_rate.mul(timeSinceLastUpdate);

	const modifiedDepositRate = modifiedBorrowRate
		.mul(utilization)
		.div(BANK_UTILIZATION_PRECISION);

	const borrowInterest = bank.cumulativeBorrowInterest
		.mul(modifiedBorrowRate)
		.div(ONE_YEAR)
		.div(BANK_INTEREST_PRECISION)
		.add(ONE);
	const depositInterest = bank.cumulativeDepositInterest
		.mul(modifiedDepositRate)
		.div(ONE_YEAR)
		.div(BANK_INTEREST_PRECISION);

	return { borrowInterest, depositInterest };
}
