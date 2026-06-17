/**
 * Layer-1 enrichment for vault_transaction_execute operations.
 *
 * Walks tx.meta.logMessages alongside tx.meta.innerInstructions to build
 * a per-CPI summary: program id, resolved accounts, raw data (kept for
 * layer-2 decoding), the Anchor instruction name (if logged), and any
 * "Program log:" lines emitted at that depth.
 *
 * Pure function over the webhook payload — no RPC, no IDL.
 */
import { SQUADS_PROGRAM_ID, type InnerCpi, type OperationEnrichment } from './types';

interface CompiledInstruction {
	readonly programIdIndex: number;
	readonly accounts: readonly number[];
	readonly data: string;
}

/**
 * @param innerInstructions - entries of `tx.meta.innerInstructions[i].instructions`
 *                            where `i.index` matches the top-level Squads instruction position
 * @param accountKeys - resolved account keys for the transaction
 * @param logMessages - tx.meta.logMessages, used to attribute Anchor instruction
 *                     names + program logs to each CPI
 */
export function enrichLayer1(
	innerInstructions: readonly CompiledInstruction[],
	accountKeys: readonly string[],
	logMessages: readonly string[] | undefined
): OperationEnrichment {
	const innerCpis: InnerCpi[] = innerInstructions.map((instr) => ({
		programId: accountKeys[instr.programIdIndex] ?? 'unknown',
		accounts: instr.accounts.map((idx) => accountKeys[idx] ?? 'unknown'),
		dataB58: instr.data,
		instructionName: null,
		programLogs: [],
	}));

	if (logMessages && innerCpis.length > 0) {
		attributeLogs(innerCpis, logMessages);
	}

	return { innerCpis };
}

/**
 * Walks the program log stack and zips depth-2 invocations under the Squads
 * program with `cpis` in order. Inside each depth-2 block, attaches the
 * Anchor instruction name (from "Program log: Instruction: X") and any
 * "Program log: ..." lines, including those emitted from deeper nested CPIs.
 */
function attributeLogs(cpis: InnerCpi[], logs: readonly string[]): void {
	// Stack of programs currently invoked. Top of stack = innermost active program.
	const stack: { programId: string; cpi: InnerCpi | null }[] = [];
	let cursor = 0;

	for (const log of logs) {
		const invokeMatch = log.match(/^Program (\S+) invoke \[(\d+)\]$/);
		if (invokeMatch) {
			const programId = invokeMatch[1]!;
			const depth = parseInt(invokeMatch[2]!, 10);

			let cpi: InnerCpi | null = null;
			const top = stack[stack.length - 1];

			if (depth >= 2 && top?.programId === SQUADS_PROGRAM_ID) {
				// Depth-2 CPI directly under Squads — match against the next pending cpi.
				if (cursor < cpis.length && cpis[cursor]?.programId === programId) {
					cpi = cpis[cursor]!;
					cursor++;
				}
			} else if (depth >= 2 && top?.cpi) {
				// Deeper nested CPI — keep attributing to the outermost ancestor cpi.
				cpi = top.cpi;
			}

			stack.push({ programId, cpi });
			continue;
		}

		if (/^Program (\S+) (success|failed.*)$/.test(log)) {
			stack.pop();
			continue;
		}

		const top = stack[stack.length - 1];
		if (!top?.cpi) continue;

		const ixMatch = log.match(/^Program log: Instruction: (.+)$/);
		if (ixMatch && top.cpi.instructionName === null) {
			top.cpi.instructionName = ixMatch[1]!;
			continue;
		}

		const logMatch = log.match(/^Program log: (.+)$/);
		if (logMatch) {
			top.cpi.programLogs.push(logMatch[1]!);
		}
	}
}
