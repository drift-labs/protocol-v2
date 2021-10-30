import { Transaction, TransactionInstruction } from '@solana/web3.js';

export function wrapInTx(instruction: TransactionInstruction): Transaction {
	return new Transaction().add(instruction);
}
