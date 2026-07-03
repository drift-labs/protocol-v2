import {
	ComputeBudgetProgram,
	Connection,
	Finality,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';

/**
 * Fetches a confirmed transaction and extracts, from its log messages, every "consumed compute
 * units" line attributable to `programId`. A transaction can invoke the same program more than
 * once (e.g. via CPI or multiple instructions), so this returns one entry per matching log line
 * rather than a single total.
 * @param programId - Program whose compute-unit consumption to extract.
 * @param connection - RPC connection used to fetch the transaction.
 * @param txSignature - Signature of the transaction to inspect.
 * @param commitment - Finality level to fetch the transaction at; defaults to `'confirmed'`.
 * @returns The consumed-compute-unit counts (as strings, parsed straight from the log text) for
 * each invocation of `programId` found in the transaction's logs; empty if the transaction has no
 * log messages (e.g. not yet available at the requested commitment).
 */
export async function findComputeUnitConsumption(
	programId: PublicKey,
	connection: Connection,
	txSignature: string,
	commitment: Finality = 'confirmed'
): Promise<string[]> {
	const tx = await connection.getTransaction(txSignature, { commitment });
	const computeUnits: string[] = [];
	const logMessages = tx?.meta?.logMessages;
	if (!logMessages) {
		return computeUnits;
	}
	const regex = new RegExp(
		`Program ${programId.toString()} consumed ([0-9]{0,6}) of ([0-9]{0,7}) compute units`
	);
	logMessages.forEach((logMessage) => {
		const match = logMessage.match(regex);
		if (match && match[1]) {
			computeUnits.push(match[1]);
		}
	});
	return computeUnits;
}

/**
 * Checks whether `ix` is a `ComputeBudgetProgram.setComputeUnitLimit` instruction, by matching
 * the program id and the instruction discriminator byte (`2`).
 * @param ix - Instruction to check.
 * @returns `true` if `ix` sets the transaction's compute unit limit.
 */
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

/**
 * Checks whether `ix` is a `ComputeBudgetProgram.setComputeUnitPrice` instruction, by matching
 * the program id and the instruction discriminator byte (`3`).
 * @param ix - Instruction to check.
 * @returns `true` if `ix` sets the transaction's compute unit price (priority fee).
 */
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

/**
 * Checks a list of instructions for the presence of compute-budget limit/price instructions —
 * used by tx builders to avoid appending a duplicate `setComputeUnitLimit`/`setComputeUnitPrice`
 * instruction when the caller already supplied one.
 * @param ixs - Instructions to scan (typically an in-progress transaction's instruction list).
 * @returns Whether a `setComputeUnitLimit` and/or `setComputeUnitPrice` instruction is present.
 */
export function containsComputeUnitIxs(ixs: TransactionInstruction[]): {
	hasSetComputeUnitLimitIx: boolean;
	hasSetComputeUnitPriceIx: boolean;
} {
	return {
		hasSetComputeUnitLimitIx: ixs.some(isSetComputeUnitsIx),
		hasSetComputeUnitPriceIx: ixs.some(isSetComputeUnitPriceIx),
	};
}
