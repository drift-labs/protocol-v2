import { BankAccount, BankBalanceType, isVariant } from '../types';
import { BN } from '@project-serum/anchor';
import {
	BANK_UTILIZATION_PRECISION,
	ONE,
	TEN,
	ZERO,
	BANK_INTEREST_PRECISION,
	ONE_YEAR,
} from '../constants/numericConstants';

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
