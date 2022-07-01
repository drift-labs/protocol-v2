import {
	Transaction,
	TransactionInstruction,
	ComputeBudgetProgram,
} from '@solana/web3.js';

const COMPUTE_UNITS_DEFAULT = 200_000;

export function wrapInTx(
	instruction: TransactionInstruction,
	computeUnits = 500_000 // TODO, requires less code change
): Transaction {
	const tx = new Transaction();
	if (computeUnits != COMPUTE_UNITS_DEFAULT) {
		tx.add(
			ComputeBudgetProgram.requestUnits({
				units: computeUnits,
				additionalFee: 0,
			})
		);
	}

	return tx.add(instruction);
}
