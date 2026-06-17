import type { InstructionKind } from './discriminator';

export interface AccountLayout {
	readonly multisigIndex: number;
	readonly memberIndex: number;
	readonly transactionIndex: number | null;
	readonly proposalIndex: number | null;
}

/**
 * Returns the account layout for a given instruction kind.
 * Derived from the Squads v4 Anchor IDL account ordering.
 */
export function layoutFor(kind: InstructionKind): AccountLayout {
	switch (kind) {
		// -- Multisig creation --
		case 'multisig_create':
			return {
				multisigIndex: 0,
				memberIndex: 1,
				transactionIndex: null,
				proposalIndex: null,
			};
		case 'multisig_create_v2':
			return {
				multisigIndex: 2,
				memberIndex: 4,
				transactionIndex: null,
				proposalIndex: null,
			};

		// -- Proposal lifecycle --
		case 'proposal_create':
			return {
				multisigIndex: 0,
				memberIndex: 2,
				transactionIndex: null,
				proposalIndex: 1,
			};
		case 'proposal_activate':
		case 'proposal_approve':
		case 'proposal_reject':
		case 'proposal_cancel':
		case 'proposal_cancel_v2':
			return {
				multisigIndex: 0,
				memberIndex: 1,
				transactionIndex: null,
				proposalIndex: 2,
			};

		// -- Transaction creation --
		case 'vault_transaction_create':
		case 'config_transaction_create':
			return {
				multisigIndex: 0,
				memberIndex: 2,
				transactionIndex: 1,
				proposalIndex: null,
			};

		// -- Transaction execution --
		case 'vault_transaction_execute':
			return {
				multisigIndex: 0,
				memberIndex: 3,
				transactionIndex: 2,
				proposalIndex: 1,
			};
		case 'config_transaction_execute':
			return {
				multisigIndex: 0,
				memberIndex: 1,
				transactionIndex: 3,
				proposalIndex: 2,
			};

		// -- Controlled multisig direct config --
		case 'multisig_add_member':
		case 'multisig_remove_member':
		case 'multisig_change_threshold':
		case 'multisig_set_time_lock':
		case 'multisig_set_config_authority':
		case 'multisig_set_rent_collector':
		case 'multisig_add_spending_limit':
		case 'multisig_remove_spending_limit':
			return {
				multisigIndex: 0,
				memberIndex: 1,
				transactionIndex: null,
				proposalIndex: null,
			};

		// -- Spending limit usage --
		case 'spending_limit_use':
			return {
				multisigIndex: 0,
				memberIndex: 1,
				transactionIndex: null,
				proposalIndex: null,
			};

		// -- Buffer operations --
		case 'transaction_buffer_create':
		case 'transaction_buffer_extend':
		case 'transaction_buffer_close':
			return {
				multisigIndex: 0,
				memberIndex: 2,
				transactionIndex: null,
				proposalIndex: null,
			};
		case 'vault_transaction_create_from_buffer':
			return {
				multisigIndex: 0,
				memberIndex: 2,
				transactionIndex: 1,
				proposalIndex: null,
			};

		// -- Batch operations --
		case 'batch_create':
			return {
				multisigIndex: 0,
				memberIndex: 2,
				transactionIndex: null,
				proposalIndex: null,
			};
		case 'batch_add_transaction':
			return {
				multisigIndex: 0,
				memberIndex: 4,
				transactionIndex: 3,
				proposalIndex: 1,
			};
		case 'batch_execute_transaction':
			return {
				multisigIndex: 0,
				memberIndex: 1,
				transactionIndex: 4,
				proposalIndex: 2,
			};

		// -- Account cleanup --
		case 'config_transaction_accounts_close':
		case 'vault_transaction_accounts_close':
			return {
				multisigIndex: 0,
				memberIndex: 3,
				transactionIndex: 2,
				proposalIndex: 1,
			};
		case 'vault_batch_transaction_account_close':
			return {
				multisigIndex: 0,
				memberIndex: 4,
				transactionIndex: 3,
				proposalIndex: 1,
			};
		case 'batch_accounts_close':
			return {
				multisigIndex: 0,
				memberIndex: 3,
				transactionIndex: null,
				proposalIndex: 1,
			};
	}
}

/** Resolves a pubkey from instruction account indices and top-level accountKeys. */
export function resolvePubkey(
	instructionAccounts: readonly number[],
	accountKeys: readonly string[],
	position: number
): string | null {
	const idx = instructionAccounts[position];
	if (idx === undefined) return null;
	return accountKeys[idx] ?? null;
}
