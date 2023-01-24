import {
	Transaction,
	TransactionInstruction,
	ComputeBudgetProgram,
} from '@solana/web3.js';

const COMPUTE_UNITS_DEFAULT = 200_000;

export function wrapInTx(
	instruction: TransactionInstruction,
	computeUnits = 600_000,
	computeUnitsPrice = 0
): Transaction {
	const tx = new Transaction();
	if (computeUnits != COMPUTE_UNITS_DEFAULT) {
		tx.add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: computeUnits,
			})
		);
	}

	if (computeUnitsPrice != 0) {
		tx.add(
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports: computeUnitsPrice,
			})
		);
	}

	return tx.add(instruction);
}
