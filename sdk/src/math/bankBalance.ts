import { BankAccount, BankBalanceType, isVariant } from '../types';
import { BN } from '@project-serum/anchor';
import { ONE, TEN, ZERO } from '../constants/numericConstants';

export function getBalance(
	tokenAmount: BN,
	bank: BankAccount,
	balanceType: BankBalanceType
): BN {
	const precisionIncrease = TEN.pow(new BN(12 - bank.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? bank.cumulativeDepositInterest
		: bank.cumulativeBorrowInterest;

	let balance = tokenAmount.mul(precisionIncrease).div(cumulativeInterest);

	if (!balance.eq(ZERO) && isVariant(balanceType, 'borrow')) {
		balance = balance.add(ONE);
	}

	return balance;
}
