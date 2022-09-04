import { BN } from '@project-serum/anchor';
import { BankAccount } from '../types';

export function castNumberToBankPrecision(
	value: number,
	bankAccount: BankAccount
): BN {
	return new BN(value * Math.pow(10, bankAccount.decimals));
}
