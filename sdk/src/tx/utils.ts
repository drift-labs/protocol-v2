import { Transaction, VersionedTransaction } from '@solana/web3.js';

export const isVersionedTransaction = (
	tx: Transaction | VersionedTransaction
): boolean => {
	const version = (tx as VersionedTransaction)?.version;
	const isVersionedTx =
		tx instanceof VersionedTransaction || version !== undefined;

	return isVersionedTx;
};
