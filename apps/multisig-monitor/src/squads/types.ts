export const SQUADS_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

export interface DetectedOperation {
	readonly signature: string;
	readonly multisig: string;
	readonly member: string;
	readonly transactionAddress: string | null;
	readonly proposalAddress: string | null;
	readonly operation: SquadsOperation;
	readonly blockTime: number | null;
	/** Inner-CPI summaries for vault_transaction_execute. Populated by enrichment. */
	enrichment?: OperationEnrichment;
}

export interface OperationEnrichment {
	innerCpis: InnerCpi[];
}

export interface InnerCpi {
	programId: string;
	accounts: string[];
	/** Base58-encoded raw instruction data. Kept around so layer-2 decoding can re-parse. */
	dataB58: string;
	/** Anchor instruction name extracted from "Program log: Instruction: X". */
	instructionName: string | null;
	/** All "Program log: ..." lines emitted while this CPI was on the call stack. */
	programLogs: string[];
	/** Decoded instruction args (layer 2). Absent if IDL fetch/decode failed. */
	decoded?: DecodedInstruction;
}

export interface DecodedInstruction {
	name: string;
	args: { name: string; value: string }[];
}

// -- Permissions --

export interface Permissions {
	readonly mask: number;
}

export function permissionLabels(p: Permissions): string[] {
	const labels: string[] = [];
	if (p.mask & 1) labels.push('Initiate');
	if (p.mask & 2) labels.push('Vote');
	if (p.mask & 4) labels.push('Execute');
	if (labels.length === 0) labels.push('None');
	return labels;
}

export interface MemberEntry {
	readonly key: string;
	readonly permissions: Permissions;
}

// -- Config changes (used in config_transaction_create args) --

export type ConfigChange =
	| {
			readonly kind: 'add_member';
			readonly member: string;
			readonly permissions: Permissions;
	  }
	| { readonly kind: 'remove_member'; readonly member: string }
	| { readonly kind: 'change_threshold'; readonly newThreshold: number }
	| { readonly kind: 'set_time_lock'; readonly seconds: number }
	| {
			readonly kind: 'add_spending_limit';
			readonly createKey: string;
			readonly vaultIndex: number;
			readonly mint: string;
			readonly amount: bigint;
			readonly members: readonly string[];
			readonly destinations: readonly string[];
	  }
	| { readonly kind: 'remove_spending_limit'; readonly spendingLimit: string }
	| { readonly kind: 'set_rent_collector'; readonly collector: string | null };

export function configChangeDescription(c: ConfigChange): string {
	switch (c.kind) {
		case 'add_member':
			return `Add member ${c.member} (permissions: ${permissionLabels(c.permissions).join(
				', '
			)})`;
		case 'remove_member':
			return `Remove member ${c.member}`;
		case 'change_threshold':
			return `Change threshold to ${c.newThreshold}`;
		case 'set_time_lock':
			return `Set time lock to ${c.seconds}s`;
		case 'add_spending_limit':
			return `Add spending limit: ${c.amount} of ${c.mint} on vault ${c.vaultIndex}`;
		case 'remove_spending_limit':
			return `Remove spending limit ${c.spendingLimit}`;
		case 'set_rent_collector':
			return c.collector ? `Set rent collector to ${c.collector}` : 'Remove rent collector';
	}
}

// -- Operations --

export type SquadsOperation =
	| {
			readonly kind: 'multisig_create';
			readonly configAuthority: string | null;
			readonly threshold: number;
			readonly members: readonly MemberEntry[];
	  }
	| { readonly kind: 'proposal_create'; readonly draft: boolean }
	| { readonly kind: 'proposal_activate' }
	| { readonly kind: 'proposal_approve' }
	| { readonly kind: 'proposal_reject' }
	| { readonly kind: 'proposal_cancel' }
	| { readonly kind: 'proposal_cancel_v2' }
	| { readonly kind: 'vault_transaction_create' }
	| {
			readonly kind: 'config_transaction_create';
			readonly actions: readonly ConfigChange[];
	  }
	| { readonly kind: 'vault_transaction_execute' }
	| { readonly kind: 'config_transaction_execute' }
	| {
			readonly kind: 'multisig_add_member';
			readonly newMember: MemberEntry;
	  }
	| { readonly kind: 'multisig_remove_member'; readonly oldMember: string }
	| {
			readonly kind: 'multisig_change_threshold';
			readonly newThreshold: number;
	  }
	| { readonly kind: 'multisig_set_time_lock'; readonly timeLock: number }
	| {
			readonly kind: 'multisig_set_config_authority';
			readonly configAuthority: string;
	  }
	| {
			readonly kind: 'multisig_set_rent_collector';
			readonly rentCollector: string | null;
	  }
	| {
			readonly kind: 'multisig_add_spending_limit';
			readonly createKey: string;
			readonly vaultIndex: number;
			readonly mint: string;
			readonly amount: bigint;
			readonly members: readonly string[];
			readonly destinations: readonly string[];
	  }
	| { readonly kind: 'multisig_remove_spending_limit' }
	| {
			readonly kind: 'spending_limit_use';
			readonly amount: bigint;
			readonly decimals: number;
	  }
	| { readonly kind: 'transaction_buffer_create' }
	| { readonly kind: 'transaction_buffer_extend' }
	| { readonly kind: 'transaction_buffer_close' }
	| { readonly kind: 'vault_transaction_create_from_buffer' }
	| { readonly kind: 'batch_create' }
	| { readonly kind: 'batch_add_transaction' }
	| { readonly kind: 'batch_execute_transaction' }
	| { readonly kind: 'config_transaction_accounts_close' }
	| { readonly kind: 'vault_transaction_accounts_close' }
	| { readonly kind: 'vault_batch_transaction_account_close' }
	| { readonly kind: 'batch_accounts_close' };

export function displayName(op: SquadsOperation): string {
	const names: Record<string, string> = {
		multisig_create: 'Multisig Created',
		proposal_create: 'Proposal Created',
		proposal_activate: 'Proposal Activated',
		proposal_approve: 'Proposal Approved',
		proposal_reject: 'Proposal Rejected',
		proposal_cancel: 'Proposal Cancelled',
		proposal_cancel_v2: 'Proposal Cancelled (V2)',
		vault_transaction_create: 'Vault Transaction Created',
		config_transaction_create: 'Config Transaction Created',
		vault_transaction_execute: 'Vault Transaction Executed',
		config_transaction_execute: 'Config Transaction Executed',
		multisig_add_member: 'Direct: Member Added',
		multisig_remove_member: 'Direct: Member Removed',
		multisig_change_threshold: 'Direct: Threshold Changed',
		multisig_set_time_lock: 'Direct: Time Lock Set',
		multisig_set_config_authority: 'Direct: Config Authority Changed',
		multisig_set_rent_collector: 'Direct: Rent Collector Set',
		multisig_add_spending_limit: 'Direct: Spending Limit Added',
		multisig_remove_spending_limit: 'Direct: Spending Limit Removed',
		spending_limit_use: 'Spending Limit Used',
		transaction_buffer_create: 'Transaction Buffer Created',
		transaction_buffer_extend: 'Transaction Buffer Extended',
		transaction_buffer_close: 'Transaction Buffer Closed',
		vault_transaction_create_from_buffer: 'Vault Transaction Created (from Buffer)',
		batch_create: 'Batch Created',
		batch_add_transaction: 'Batch Transaction Added',
		batch_execute_transaction: 'Batch Transaction Executed',
		config_transaction_accounts_close: 'Config Transaction Accounts Closed',
		vault_transaction_accounts_close: 'Vault Transaction Accounts Closed',
		vault_batch_transaction_account_close: 'Vault Batch Transaction Account Closed',
		batch_accounts_close: 'Batch Accounts Closed',
	};
	return names[op.kind] ?? op.kind;
}

export function emoji(op: SquadsOperation): string {
	const map: Record<string, string> = {
		multisig_create: '\u{1f3d7}\u{fe0f}',
		proposal_create: '\u{1f4dd}',
		proposal_activate: '\u{26a1}',
		proposal_approve: '\u{2705}',
		proposal_reject: '\u{274c}',
		proposal_cancel: '\u{1f6ab}',
		proposal_cancel_v2: '\u{1f6ab}',
		vault_transaction_create: '\u{1f4e6}',
		config_transaction_create: '\u{2699}\u{fe0f}',
		vault_transaction_execute: '\u{1f680}',
		config_transaction_execute: '\u{1f680}',
		multisig_add_member: '\u{26a0}\u{fe0f}',
		multisig_remove_member: '\u{26a0}\u{fe0f}',
		multisig_change_threshold: '\u{26a0}\u{fe0f}',
		multisig_set_time_lock: '\u{26a0}\u{fe0f}',
		multisig_set_config_authority: '\u{26a0}\u{fe0f}',
		multisig_set_rent_collector: '\u{26a0}\u{fe0f}',
		multisig_add_spending_limit: '\u{26a0}\u{fe0f}',
		multisig_remove_spending_limit: '\u{26a0}\u{fe0f}',
		spending_limit_use: '\u{1f4b8}',
		transaction_buffer_create: '\u{1f4cb}',
		transaction_buffer_extend: '\u{1f4cb}',
		transaction_buffer_close: '\u{1f4cb}',
		vault_transaction_create_from_buffer: '\u{1f4e6}',
		batch_create: '\u{1f4e6}',
		batch_add_transaction: '\u{1f4e6}',
		batch_execute_transaction: '\u{1f4e6}',
		config_transaction_accounts_close: '\u{1f9f9}',
		vault_transaction_accounts_close: '\u{1f9f9}',
		vault_batch_transaction_account_close: '\u{1f9f9}',
		batch_accounts_close: '\u{1f9f9}',
	};
	return map[op.kind] ?? '\u{1f514}';
}

export function memberRole(op: SquadsOperation): string {
	switch (op.kind) {
		case 'multisig_create':
		case 'proposal_create':
		case 'vault_transaction_create':
		case 'vault_transaction_create_from_buffer':
		case 'config_transaction_create':
		case 'transaction_buffer_create':
		case 'transaction_buffer_extend':
		case 'transaction_buffer_close':
		case 'batch_create':
			return 'Creator';
		case 'proposal_activate':
			return 'Activator';
		case 'proposal_approve':
			return 'Approver';
		case 'proposal_reject':
			return 'Rejector';
		case 'proposal_cancel':
		case 'proposal_cancel_v2':
			return 'Canceller';
		case 'vault_transaction_execute':
		case 'config_transaction_execute':
		case 'batch_execute_transaction':
			return 'Executor';
		case 'batch_add_transaction':
		case 'spending_limit_use':
			return 'Member';
		case 'multisig_add_member':
		case 'multisig_remove_member':
		case 'multisig_change_threshold':
		case 'multisig_set_time_lock':
		case 'multisig_set_config_authority':
		case 'multisig_set_rent_collector':
		case 'multisig_add_spending_limit':
		case 'multisig_remove_spending_limit':
			return 'Config Authority';
		case 'config_transaction_accounts_close':
		case 'vault_transaction_accounts_close':
		case 'vault_batch_transaction_account_close':
		case 'batch_accounts_close':
			return 'Closer';
	}
}

export function truncateAddress(address: string): string {
	if (address.length <= 12) return address;
	return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
