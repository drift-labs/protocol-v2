import type { InstructionKind } from './squads/discriminator';
import type { ConfigChange, SquadsOperation } from './squads/types';
import { ANCHOR_NAMES } from './squads/discriminator';

export interface NotificationFilter {
	readonly instructionTypes: readonly string[];
	readonly configTypes: readonly string[];
}

const CONFIG_TYPE_KEYS = [
	'add_member',
	'remove_member',
	'change_threshold',
	'set_time_lock',
	'add_spending_limit',
	'remove_spending_limit',
	'set_rent_collector',
] as const;

export function allowsInstruction(filter: NotificationFilter, kind: InstructionKind): boolean {
	if (filter.instructionTypes.length === 0) return true;
	return filter.instructionTypes.includes(ANCHOR_NAMES[kind]);
}

export function applyFilter(
	filter: NotificationFilter,
	operation: SquadsOperation
): SquadsOperation | null {
	if (operation.kind === 'config_transaction_create' && operation.actions.length > 0) {
		const filtered = filterConfigActions(filter, operation.actions);
		if (filtered.length === 0) return null;
		return { ...operation, actions: filtered };
	}
	return operation;
}

function filterConfigActions(
	filter: NotificationFilter,
	actions: readonly ConfigChange[]
): ConfigChange[] {
	if (filter.configTypes.length === 0) return [...actions];
	return actions.filter((a) => filter.configTypes.includes(a.kind));
}

function configChangeKey(kind: string): boolean {
	return (CONFIG_TYPE_KEYS as readonly string[]).includes(kind);
}

export function validateFilter(filter: NotificationFilter): void {
	const validInstructionTypes = Object.values(ANCHOR_NAMES);
	for (const t of filter.instructionTypes) {
		if (!validInstructionTypes.includes(t)) {
			throw new Error(
				`unknown instruction type '${t}'. valid types: ${validInstructionTypes.join(', ')}`
			);
		}
	}
	for (const t of filter.configTypes) {
		if (!configChangeKey(t)) {
			throw new Error(
				`unknown config type '${t}'. valid types: ${CONFIG_TYPE_KEYS.join(', ')}`
			);
		}
	}
}

export function parseCommaList(input: string): string[] {
	return input
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}
