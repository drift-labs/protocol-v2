import bs58 from 'bs58';
import type { InstructionKind } from './discriminator';
import type { ConfigChange, MemberEntry, SquadsOperation } from './types';

/**
 * Minimal Borsh reader for decoding Squads v4 instruction arguments.
 * Reads little-endian integers, fixed-size byte arrays, Vecs, Options,
 * and strings — the subset needed for all Squads instruction args.
 */
class BorshReader {
	private offset = 0;
	constructor(private readonly data: Uint8Array) {}

	get remaining(): number {
		return this.data.length - this.offset;
	}

	u8(): number {
		const v = this.data[this.offset];
		if (v === undefined) throw new Error('borsh: unexpected end of data');
		this.offset += 1;
		return v;
	}

	u16(): number {
		const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2);
		this.offset += 2;
		return view.getUint16(0, true);
	}

	u32(): number {
		const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4);
		this.offset += 4;
		return view.getUint32(0, true);
	}

	u64(): bigint {
		const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8);
		this.offset += 8;
		return view.getBigUint64(0, true);
	}

	bool(): boolean {
		return this.u8() !== 0;
	}

	bytes(n: number): Uint8Array {
		const slice = this.data.subarray(this.offset, this.offset + n);
		this.offset += n;
		return slice;
	}

	pubkey(): string {
		return bs58.encode(this.bytes(32));
	}

	optionPubkey(): string | null {
		const tag = this.u8();
		return tag === 1 ? this.pubkey() : null;
	}

	optionString(): string | null {
		const tag = this.u8();
		return tag === 1 ? this.string() : null;
	}

	string(): string {
		const len = this.u32();
		if (len > this.remaining) throw new Error('borsh: string length exceeds remaining data');
		const bytes = this.bytes(len);
		return new TextDecoder().decode(bytes);
	}

	member(): MemberEntry {
		const key = this.pubkey();
		const mask = this.u8();
		return { key, permissions: { mask } };
	}

	vec<T>(readItem: () => T): T[] {
		const len = this.u32();
		if (len > this.remaining) throw new Error('borsh: vec length exceeds remaining data');
		const items: T[] = [];
		for (let i = 0; i < len; i++) {
			items.push(readItem());
		}
		return items;
	}

	/** Borsh enum variant index (1 byte). */
	enumVariant(): number {
		return this.u8();
	}

	/** Skip the Period enum (1 byte variant, no fields). */
	period(): void {
		this.u8();
	}
}

/** Strips the 8-byte Anchor discriminator and returns a reader over the args. */
function argsReader(data: Uint8Array): BorshReader {
	if (data.length < 8) throw new Error('instruction data too short');
	return new BorshReader(data.subarray(8));
}

// ---------------------------------------------------------------------------
// Config action decoding
// ---------------------------------------------------------------------------

function readConfigAction(r: BorshReader): ConfigChange {
	const variant = r.enumVariant();
	switch (variant) {
		case 0: {
			const entry = r.member();
			return {
				kind: 'add_member',
				member: entry.key,
				permissions: entry.permissions,
			};
		}
		case 1:
			return { kind: 'remove_member', member: r.pubkey() };
		case 2:
			return { kind: 'change_threshold', newThreshold: r.u16() };
		case 3:
			return { kind: 'set_time_lock', seconds: r.u32() };
		case 4: {
			const createKey = r.pubkey();
			const vaultIndex = r.u8();
			const mint = r.pubkey();
			const amount = r.u64();
			r.period(); // skip Period enum
			const members = r.vec(() => r.pubkey());
			const destinations = r.vec(() => r.pubkey());
			return {
				kind: 'add_spending_limit',
				createKey,
				vaultIndex,
				mint,
				amount,
				members,
				destinations,
			};
		}
		case 5:
			return { kind: 'remove_spending_limit', spendingLimit: r.pubkey() };
		case 6:
			return { kind: 'set_rent_collector', collector: r.optionPubkey() };
		default:
			throw new Error(`unknown ConfigAction variant: ${variant}`);
	}
}

// ---------------------------------------------------------------------------
// Per-instruction arg decoders
// ---------------------------------------------------------------------------

function decodeConfigTransactionCreate(data: Uint8Array): readonly ConfigChange[] {
	const r = argsReader(data);
	const actions = r.vec(() => readConfigAction(r));
	// memo (Option<String>) follows but we don't need it
	return actions;
}

function decodeMultisigCreateV2(data: Uint8Array): {
	configAuthority: string | null;
	threshold: number;
	members: readonly MemberEntry[];
} {
	const r = argsReader(data);
	const configAuthority = r.optionPubkey();
	const threshold = r.u16();
	const members = r.vec(() => r.member());
	return { configAuthority, threshold, members };
}

function decodeProposalCreate(data: Uint8Array): { draft: boolean } {
	const r = argsReader(data);
	r.u64(); // transaction_index
	const draft = r.bool();
	return { draft };
}

function decodeMultisigAddMember(data: Uint8Array): MemberEntry {
	const r = argsReader(data);
	return r.member();
}

function decodeMultisigRemoveMember(data: Uint8Array): string {
	const r = argsReader(data);
	return r.pubkey();
}

function decodeMultisigChangeThreshold(data: Uint8Array): number {
	const r = argsReader(data);
	return r.u16();
}

function decodeMultisigSetTimeLock(data: Uint8Array): number {
	const r = argsReader(data);
	return r.u32();
}

function decodeMultisigSetConfigAuthority(data: Uint8Array): string {
	const r = argsReader(data);
	return r.pubkey();
}

function decodeMultisigSetRentCollector(data: Uint8Array): string | null {
	const r = argsReader(data);
	return r.optionPubkey();
}

function decodeMultisigAddSpendingLimit(data: Uint8Array): {
	createKey: string;
	vaultIndex: number;
	mint: string;
	amount: bigint;
	members: readonly string[];
	destinations: readonly string[];
} {
	const r = argsReader(data);
	const createKey = r.pubkey();
	const vaultIndex = r.u8();
	const mint = r.pubkey();
	const amount = r.u64();
	r.period();
	const members = r.vec(() => r.pubkey());
	const destinations = r.vec(() => r.pubkey());
	return { createKey, vaultIndex, mint, amount, members, destinations };
}

function decodeSpendingLimitUse(data: Uint8Array): {
	amount: bigint;
	decimals: number;
} {
	const r = argsReader(data);
	const amount = r.u64();
	const decimals = r.u8();
	return { amount, decimals };
}

// ---------------------------------------------------------------------------
// Build operation from kind + raw data
// ---------------------------------------------------------------------------

export function buildOperation(kind: InstructionKind, data: Uint8Array): SquadsOperation | null {
	try {
		return buildOperationUnsafe(kind, data);
	} catch {
		// Fallback: return a minimal operation if arg decoding fails
		return buildFallback(kind);
	}
}

function buildOperationUnsafe(kind: InstructionKind, data: Uint8Array): SquadsOperation {
	switch (kind) {
		case 'multisig_create':
			return {
				kind: 'multisig_create',
				configAuthority: null,
				threshold: 0,
				members: [],
			};
		case 'multisig_create_v2': {
			const args = decodeMultisigCreateV2(data);
			return { kind: 'multisig_create', ...args };
		}
		case 'proposal_create': {
			const { draft } = decodeProposalCreate(data);
			return { kind: 'proposal_create', draft };
		}
		case 'proposal_activate':
			return { kind: 'proposal_activate' };
		case 'proposal_approve':
			return { kind: 'proposal_approve' };
		case 'proposal_reject':
			return { kind: 'proposal_reject' };
		case 'proposal_cancel':
			return { kind: 'proposal_cancel' };
		case 'proposal_cancel_v2':
			return { kind: 'proposal_cancel_v2' };
		case 'vault_transaction_create':
			return { kind: 'vault_transaction_create' };
		case 'config_transaction_create': {
			const actions = decodeConfigTransactionCreate(data);
			return { kind: 'config_transaction_create', actions };
		}
		case 'vault_transaction_execute':
			return { kind: 'vault_transaction_execute' };
		case 'config_transaction_execute':
			return { kind: 'config_transaction_execute' };
		case 'multisig_add_member': {
			const newMember = decodeMultisigAddMember(data);
			return { kind: 'multisig_add_member', newMember };
		}
		case 'multisig_remove_member': {
			const oldMember = decodeMultisigRemoveMember(data);
			return { kind: 'multisig_remove_member', oldMember };
		}
		case 'multisig_change_threshold': {
			const newThreshold = decodeMultisigChangeThreshold(data);
			return { kind: 'multisig_change_threshold', newThreshold };
		}
		case 'multisig_set_time_lock': {
			const timeLock = decodeMultisigSetTimeLock(data);
			return { kind: 'multisig_set_time_lock', timeLock };
		}
		case 'multisig_set_config_authority': {
			const configAuthority = decodeMultisigSetConfigAuthority(data);
			return { kind: 'multisig_set_config_authority', configAuthority };
		}
		case 'multisig_set_rent_collector': {
			const rentCollector = decodeMultisigSetRentCollector(data);
			return { kind: 'multisig_set_rent_collector', rentCollector };
		}
		case 'multisig_add_spending_limit': {
			const args = decodeMultisigAddSpendingLimit(data);
			return { kind: 'multisig_add_spending_limit', ...args };
		}
		case 'multisig_remove_spending_limit':
			return { kind: 'multisig_remove_spending_limit' };
		case 'spending_limit_use': {
			const args = decodeSpendingLimitUse(data);
			return { kind: 'spending_limit_use', ...args };
		}
		case 'transaction_buffer_create':
			return { kind: 'transaction_buffer_create' };
		case 'transaction_buffer_extend':
			return { kind: 'transaction_buffer_extend' };
		case 'transaction_buffer_close':
			return { kind: 'transaction_buffer_close' };
		case 'vault_transaction_create_from_buffer':
			return { kind: 'vault_transaction_create_from_buffer' };
		case 'batch_create':
			return { kind: 'batch_create' };
		case 'batch_add_transaction':
			return { kind: 'batch_add_transaction' };
		case 'batch_execute_transaction':
			return { kind: 'batch_execute_transaction' };
		case 'config_transaction_accounts_close':
			return { kind: 'config_transaction_accounts_close' };
		case 'vault_transaction_accounts_close':
			return { kind: 'vault_transaction_accounts_close' };
		case 'vault_batch_transaction_account_close':
			return { kind: 'vault_batch_transaction_account_close' };
		case 'batch_accounts_close':
			return { kind: 'batch_accounts_close' };
	}
}

function buildFallback(kind: InstructionKind): SquadsOperation | null {
	// For instructions that don't require decoded args, return directly.
	// For arg-dependent instructions, return with safe defaults.
	switch (kind) {
		case 'multisig_create':
		case 'multisig_create_v2':
			return {
				kind: 'multisig_create',
				configAuthority: null,
				threshold: 0,
				members: [],
			};
		case 'proposal_create':
			return { kind: 'proposal_create', draft: false };
		case 'config_transaction_create':
			return { kind: 'config_transaction_create', actions: [] };
		case 'multisig_add_member':
			return {
				kind: 'multisig_add_member',
				newMember: { key: 'unknown', permissions: { mask: 0 } },
			};
		case 'multisig_remove_member':
			return { kind: 'multisig_remove_member', oldMember: 'unknown' };
		case 'multisig_change_threshold':
			return { kind: 'multisig_change_threshold', newThreshold: 0 };
		case 'multisig_set_time_lock':
			return { kind: 'multisig_set_time_lock', timeLock: 0 };
		case 'multisig_set_config_authority':
			return {
				kind: 'multisig_set_config_authority',
				configAuthority: 'unknown',
			};
		case 'multisig_set_rent_collector':
			return { kind: 'multisig_set_rent_collector', rentCollector: null };
		case 'multisig_add_spending_limit':
			return {
				kind: 'multisig_add_spending_limit',
				createKey: 'unknown',
				vaultIndex: 0,
				mint: 'unknown',
				amount: 0n,
				members: [],
				destinations: [],
			};
		case 'spending_limit_use':
			return { kind: 'spending_limit_use', amount: 0n, decimals: 0 };
		default:
			// Simple operations with no args always succeed in buildOperationUnsafe
			return null;
	}
}
