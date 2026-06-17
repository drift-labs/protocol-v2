import bs58 from 'bs58';
import type { NotificationFilter } from '../filter';
import { allowsInstruction, applyFilter } from '../filter';
import { logError } from '../log';
import type { RawTransaction } from '../webhook';
import { layoutFor, resolvePubkey } from './accounts';
import { buildOperation } from './decoder';
import type { InstructionKind } from './discriminator';
import { getDiscriminatorMap, matchDiscriminator } from './discriminator';
import { enrichLayer1 } from './enrich';
import { enrichVaultTransactionCreate } from './enrich_create';
import type { DetectedOperation } from './types';
import { SQUADS_PROGRAM_ID } from './types';

export type { DetectedOperation } from './types';
export type { InstructionKind } from './discriminator';

/**
 * Extracts all Squads v4 operations from a batch of raw transactions,
 * filtered to only the configured multisig addresses and matching the notification filter.
 */
export async function extractOperations(
	transactions: readonly RawTransaction[],
	monitoredMultisigs: readonly string[],
	filter: NotificationFilter
): Promise<DetectedOperation[]> {
	const discMap = await getDiscriminatorMap();
	const results: DetectedOperation[] = [];

	for (const tx of transactions) {
		try {
			if (tx.meta?.err) continue;

			const blockTime = tx.blockTime ?? null;

			const signature = tx.signature ?? tx.transaction.signatures[0] ?? undefined;
			if (!signature) continue;

			const accountKeys = tx.transaction.message.accountKeys.map((k) =>
				typeof k === 'string' ? k : k.pubkey
			);

			const topLevelIxs = tx.transaction.message.instructions;
			for (let i = 0; i < topLevelIxs.length; i++) {
				const instr = topLevelIxs[i]!;
				const op = processInstruction(
					instr,
					accountKeys,
					signature,
					monitoredMultisigs,
					discMap,
					filter,
					blockTime
				);
				if (!op) continue;

				// Enrich vault_transaction_execute with inner-CPI summaries derived
				// from this top-level instruction's inner instructions + program logs.
				if (op.operation.kind === 'vault_transaction_execute') {
					const innerSet = tx.meta?.innerInstructions?.find((s) => s.index === i);
					if (innerSet) {
						op.enrichment = enrichLayer1(
							innerSet.instructions,
							accountKeys,
							tx.meta?.logMessages
						);
					}
				}

				// Enrich vault_transaction_create by parsing the embedded
				// TransactionMessage out of the instruction's data — surfaces what's
				// about to be approved before any threshold is reached.
				if (op.operation.kind === 'vault_transaction_create') {
					const enrichment = enrichVaultTransactionCreate(instr.data);
					if (enrichment) op.enrichment = enrichment;
				}

				results.push(op);
			}

			if (tx.meta?.innerInstructions) {
				for (const set of tx.meta.innerInstructions) {
					for (const instr of set.instructions) {
						const op = processInstruction(
							instr,
							accountKeys,
							signature,
							monitoredMultisigs,
							discMap,
							filter,
							blockTime
						);
						if (op) results.push(op);
					}
				}
			}
		} catch (e) {
			logError('failed to process transaction', {
				signature: tx.signature ?? tx.transaction?.signatures?.[0] ?? 'unknown',
				error: String(e),
			});
		}
	}

	return results;
}

interface CompiledInstruction {
	readonly programIdIndex: number;
	readonly accounts: readonly number[];
	readonly data: string;
}

function processInstruction(
	instr: CompiledInstruction,
	accountKeys: readonly string[],
	signature: string,
	monitoredMultisigs: readonly string[],
	discMap: Map<string, InstructionKind>,
	filter: NotificationFilter,
	blockTime: number | null
): DetectedOperation | null {
	const programId = accountKeys[instr.programIdIndex];
	if (programId !== SQUADS_PROGRAM_ID) return null;

	let data: Uint8Array;
	try {
		data = bs58.decode(instr.data);
	} catch {
		return null;
	}

	const kind = matchDiscriminator(data, discMap);
	if (!kind) return null;

	if (!allowsInstruction(filter, kind)) return null;

	const layout = layoutFor(kind);
	const multisig = resolvePubkey(instr.accounts, accountKeys, layout.multisigIndex);
	if (!multisig || !monitoredMultisigs.includes(multisig)) return null;

	const member = resolvePubkey(instr.accounts, accountKeys, layout.memberIndex);
	if (!member) return null;

	const transactionAddress =
		layout.transactionIndex !== null
			? resolvePubkey(instr.accounts, accountKeys, layout.transactionIndex)
			: null;

	const proposalAddress =
		layout.proposalIndex !== null
			? resolvePubkey(instr.accounts, accountKeys, layout.proposalIndex)
			: null;

	const operation = buildOperation(kind, data);
	if (!operation) return null;

	const filtered = applyFilter(filter, operation);
	if (!filtered) return null;

	return {
		signature,
		multisig,
		member,
		transactionAddress,
		proposalAddress,
		operation: filtered,
		blockTime,
	};
}
