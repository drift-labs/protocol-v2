/**
 * Decoder for vault_transaction_create's embedded payload.
 *
 * Squads' vault_transaction_create stores the proposed CPIs inline in the
 * instruction's data field as a Borsh-serialized TransactionMessage. We
 * extract that, re-shape each instruction as an InnerCpi, and let the
 * existing layer-2 IDL decoder + slack renderer handle the rest.
 *
 * This is the highest-leverage alerting moment: the proposed CPIs become
 * visible the instant the create instruction lands on-chain, before any
 * approval threshold is reached.
 */
import bs58 from 'bs58';
import type { InnerCpi, OperationEnrichment } from './types';

/**
 * Parses the base58-encoded data of a vault_transaction_create instruction.
 * Returns null if the data is malformed.
 */
export function enrichVaultTransactionCreate(
	instructionDataB58: string
): OperationEnrichment | null {
	let buf: Buffer;
	try {
		buf = Buffer.from(bs58.decode(instructionDataB58));
	} catch {
		return null;
	}

	// Anchor discriminator (8) + at least vault_index (1) + ephemeral_signers (1)
	// + transaction_message length prefix (4)
	if (buf.length < 14) return null;

	try {
		let off = 8; // skip Anchor discriminator
		off += 1; // vault_index
		off += 1; // ephemeral_signers

		const txMsgLen = buf.readUInt32LE(off);
		off += 4;
		if (off + txMsgLen > buf.length) return null;

		const txMsg = buf.subarray(off, off + txMsgLen);
		return parseTransactionMessage(txMsg);
	} catch {
		return null;
	}
}

/**
 * Parses a Squads compact TransactionMessage. The format is:
 *   u8 num_signers
 *   u8 num_writable_signers
 *   u8 num_writable_non_signers
 *   u8 num_account_keys
 *   [Pubkey; num_account_keys]
 *   u8 num_instructions
 *   for each:
 *     u8 program_id_index
 *     u8 num_accounts
 *     [u8; num_accounts] account_indexes
 *     u16 data_len
 *     [u8; data_len] data
 *   (address_table_lookups follow but are ignored here)
 */
function parseTransactionMessage(buf: Buffer): OperationEnrichment | null {
	let off = 0;
	if (buf.length < 4) return null;

	// num_signers, num_writable_signers, num_writable_non_signers — not needed
	off += 3;

	const numAccountKeys = buf.readUInt8(off++);
	if (off + numAccountKeys * 32 > buf.length) return null;

	const accountKeys: string[] = [];
	for (let i = 0; i < numAccountKeys; i++) {
		accountKeys.push(bs58.encode(buf.subarray(off, off + 32)));
		off += 32;
	}

	if (off >= buf.length) return null;
	const numInstructions = buf.readUInt8(off++);

	const innerCpis: InnerCpi[] = [];
	for (let i = 0; i < numInstructions; i++) {
		if (off + 2 > buf.length) return null;
		const programIdIndex = buf.readUInt8(off++);
		const numAccounts = buf.readUInt8(off++);

		if (off + numAccounts > buf.length) return null;
		const accountIndexes: number[] = [];
		for (let j = 0; j < numAccounts; j++) {
			accountIndexes.push(buf.readUInt8(off++));
		}

		if (off + 2 > buf.length) return null;
		const dataLen = buf.readUInt16LE(off);
		off += 2;

		if (off + dataLen > buf.length) return null;
		const data = buf.subarray(off, off + dataLen);
		off += dataLen;

		innerCpis.push({
			programId: accountKeys[programIdIndex] ?? 'unknown',
			accounts: accountIndexes.map((idx) => accountKeys[idx] ?? 'unknown'),
			dataB58: bs58.encode(data),
			// No logs available at create time — execution hasn't happened.
			instructionName: null,
			programLogs: [],
		});
	}

	return { innerCpis };
}
