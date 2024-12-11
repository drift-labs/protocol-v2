import {
	ComputeBudgetProgram,
	Connection,
	Finality,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';

export async function findComputeUnitConsumption(
	programId: PublicKey,
	connection: Connection,
	txSignature: string,
	commitment: Finality = 'confirmed'
): Promise<number[]> {
	const tx = await connection.getTransaction(txSignature, { commitment });
	const computeUnits = [];
	const regex = new RegExp(
		`Program ${programId.toString()} consumed ([0-9]{0,6}) of ([0-9]{0,7}) compute units`
	);
	tx.meta.logMessages.forEach((logMessage) => {
		const match = logMessage.match(regex);
		if (match && match[1]) {
			computeUnits.push(match[1]);
		}
	});
	return computeUnits;
}

export function isSetComputeUnitsIx(ix: TransactionInstruction): boolean {
	// Compute budget program discriminator is first byte
	// 2: set compute unit limit
	// 3: set compute unit price
	if (
		ix.programId.equals(ComputeBudgetProgram.programId) &&
		// @ts-ignore
		ix.data.at(0) === 2
	) {
		return true;
	}
	return false;
}

export function isSetComputeUnitPriceIx(ix: TransactionInstruction): boolean {
	// Compute budget program discriminator is first byte
	// 2: set compute unit limit
	// 3: set compute unit price
	if (
		ix.programId.equals(ComputeBudgetProgram.programId) &&
		// @ts-ignore
		ix.data.at(0) === 3
	) {
		return true;
	}
	return false;
}

export function containsComputeUnitIxs(ixs: TransactionInstruction[]): {
	hasSetComputeUnitLimitIx: boolean;
	hasSetComputeUnitPriceIx: boolean;
} {
	return {
		hasSetComputeUnitLimitIx: ixs.some(isSetComputeUnitsIx),
		hasSetComputeUnitPriceIx: ixs.some(isSetComputeUnitPriceIx),
	};
}
