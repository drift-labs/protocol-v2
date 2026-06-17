/**
 * Detects nonce account creation that targets a watched council signer.
 *
 * The filter is on the *authority arg* of SystemProgram::InitializeNonceAccount,
 * not the tx signer. This is critical: in the observed Drift exploit, the
 * malicious nonce account was created by a fresh attacker-controlled
 * wallet (`FMJnBkV...`) which paid for and signed the create tx, while
 * passing the targeted council member's pubkey as the authority argument.
 * A signer-based filter would have missed it entirely.
 */
import bs58 from 'bs58';
import type { CompiledInstruction, RawTransaction } from '../webhook';
import type { SignerEvent } from './types';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const INITIALIZE_NONCE_ACCOUNT_VARIANT = 6;

export function extractSignerEvents(
	transactions: readonly RawTransaction[],
	monitoredSigners: readonly string[]
): SignerEvent[] {
	if (monitoredSigners.length === 0) return [];
	const watchSet = new Set(monitoredSigners);
	const events: SignerEvent[] = [];

	for (const tx of transactions) {
		if (tx.meta?.err) continue;

		const signature = tx.signature ?? tx.transaction.signatures[0];
		if (!signature) continue;

		const accountKeys = tx.transaction.message.accountKeys;
		const flatKeys = accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));

		// Solana protocol invariant: accountKeys[0] is always the fee payer
		// and a required signer. Whoever is here paid for and signed this tx.
		const funder = flatKeys[0];
		if (!funder) continue;

		const allInstrs: CompiledInstruction[] = [...tx.transaction.message.instructions];
		if (tx.meta?.innerInstructions) {
			for (const set of tx.meta.innerInstructions) {
				allInstrs.push(...set.instructions);
			}
		}

		for (const instr of allInstrs) {
			const programId = flatKeys[instr.programIdIndex];
			if (programId !== SYSTEM_PROGRAM) continue;

			const decoded = decodeInitializeNonceAccount(instr, flatKeys);
			if (!decoded) continue;

			// Match on the authority arg, NOT the tx signers — catches the case
			// where a different (often attacker-controlled) wallet funds the
			// creation while installing a watched council member as authority.
			if (!watchSet.has(decoded.nonceAuthority)) continue;

			events.push({
				signature,
				blockTime: tx.blockTime ?? null,
				kind: 'nonce_account_targeting_signer',
				targetedSigner: decoded.nonceAuthority,
				funder,
				nonceAccount: decoded.nonceAccount,
			});
		}
	}

	return events;
}

interface NonceInitArgs {
	nonceAccount: string;
	nonceAuthority: string;
}

function decodeInitializeNonceAccount(
	instr: CompiledInstruction,
	accountKeys: readonly string[]
): NonceInitArgs | null {
	let data: Uint8Array;
	try {
		data = bs58.decode(instr.data);
	} catch {
		return null;
	}
	// 4-byte LE variant tag + 32-byte nonce authority pubkey
	if (data.length < 4 + 32) return null;

	const variant = data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24);
	if (variant !== INITIALIZE_NONCE_ACCOUNT_VARIANT) return null;

	const nonceAuthority = bs58.encode(data.subarray(4, 4 + 32));
	const nonceAccountIdx = instr.accounts[0];
	if (nonceAccountIdx === undefined) return null;
	const nonceAccount = accountKeys[nonceAccountIdx];
	if (!nonceAccount) return null;

	return { nonceAccount, nonceAuthority };
}
