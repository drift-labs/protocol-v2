/**
 * All Squads v4 instruction kinds we monitor (excluding programConfig*).
 * The string values are the Anchor instruction names used for discriminator computation.
 */
export type InstructionKind =
	| 'multisig_create'
	| 'multisig_create_v2'
	| 'proposal_create'
	| 'proposal_activate'
	| 'proposal_approve'
	| 'proposal_reject'
	| 'proposal_cancel'
	| 'proposal_cancel_v2'
	| 'vault_transaction_create'
	| 'config_transaction_create'
	| 'vault_transaction_execute'
	| 'config_transaction_execute'
	| 'multisig_add_member'
	| 'multisig_remove_member'
	| 'multisig_change_threshold'
	| 'multisig_set_time_lock'
	| 'multisig_set_config_authority'
	| 'multisig_set_rent_collector'
	| 'multisig_add_spending_limit'
	| 'multisig_remove_spending_limit'
	| 'spending_limit_use'
	| 'transaction_buffer_create'
	| 'transaction_buffer_extend'
	| 'transaction_buffer_close'
	| 'vault_transaction_create_from_buffer'
	| 'batch_create'
	| 'batch_add_transaction'
	| 'batch_execute_transaction'
	| 'config_transaction_accounts_close'
	| 'vault_transaction_accounts_close'
	| 'vault_batch_transaction_account_close'
	| 'batch_accounts_close';

/** Maps InstructionKind to its Anchor name (identity map since we use anchor names as keys). */
export const ANCHOR_NAMES: Record<InstructionKind, string> = {
	multisig_create: 'multisig_create',
	multisig_create_v2: 'multisig_create_v2',
	proposal_create: 'proposal_create',
	proposal_activate: 'proposal_activate',
	proposal_approve: 'proposal_approve',
	proposal_reject: 'proposal_reject',
	proposal_cancel: 'proposal_cancel',
	proposal_cancel_v2: 'proposal_cancel_v2',
	vault_transaction_create: 'vault_transaction_create',
	config_transaction_create: 'config_transaction_create',
	vault_transaction_execute: 'vault_transaction_execute',
	config_transaction_execute: 'config_transaction_execute',
	multisig_add_member: 'multisig_add_member',
	multisig_remove_member: 'multisig_remove_member',
	multisig_change_threshold: 'multisig_change_threshold',
	multisig_set_time_lock: 'multisig_set_time_lock',
	multisig_set_config_authority: 'multisig_set_config_authority',
	multisig_set_rent_collector: 'multisig_set_rent_collector',
	multisig_add_spending_limit: 'multisig_add_spending_limit',
	multisig_remove_spending_limit: 'multisig_remove_spending_limit',
	spending_limit_use: 'spending_limit_use',
	transaction_buffer_create: 'transaction_buffer_create',
	transaction_buffer_extend: 'transaction_buffer_extend',
	transaction_buffer_close: 'transaction_buffer_close',
	vault_transaction_create_from_buffer: 'vault_transaction_create_from_buffer',
	batch_create: 'batch_create',
	batch_add_transaction: 'batch_add_transaction',
	batch_execute_transaction: 'batch_execute_transaction',
	config_transaction_accounts_close: 'config_transaction_accounts_close',
	vault_transaction_accounts_close: 'vault_transaction_accounts_close',
	vault_batch_transaction_account_close: 'vault_batch_transaction_account_close',
	batch_accounts_close: 'batch_accounts_close',
};

const ALL_KINDS = Object.keys(ANCHOR_NAMES) as InstructionKind[];

/** Computes sha256("global:<name>") and returns the first 8 bytes as a hex string. */
async function computeDiscriminator(name: string): Promise<string> {
	const data = new TextEncoder().encode(`global:${name}`);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return hexFromBytes(new Uint8Array(hash, 0, 8));
}

function hexFromBytes(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** Promise singleton — eliminates the race when concurrent requests both see null. */
let mapPromise: Promise<Map<string, InstructionKind>> | null = null;

/** Builds (or returns cached) discriminator → InstructionKind map. */
export function getDiscriminatorMap(): Promise<Map<string, InstructionKind>> {
	if (!mapPromise) {
		mapPromise = buildMap();
	}
	return mapPromise;
}

async function buildMap(): Promise<Map<string, InstructionKind>> {
	const entries = await Promise.all(
		ALL_KINDS.map(async (kind) => {
			const disc = await computeDiscriminator(ANCHOR_NAMES[kind]);
			return [disc, kind] as const;
		})
	);
	return new Map(entries);
}

/** Matches the first 8 bytes of instruction data against known discriminators. */
export function matchDiscriminator(
	data: Uint8Array,
	map: Map<string, InstructionKind>
): InstructionKind | null {
	if (data.length < 8) return null;
	const hex = hexFromBytes(data.subarray(0, 8));
	return map.get(hex) ?? null;
}
