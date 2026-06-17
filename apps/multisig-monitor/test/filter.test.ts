import {
	allowsInstruction,
	applyFilter,
	validateFilter,
	parseCommaList,
	type NotificationFilter,
} from '../src/filter';

const defaultFilter: NotificationFilter = {
	instructionTypes: [],
	configTypes: [],
};

describe('filter', () => {
	it('empty instruction_types allows all', () => {
		expect(allowsInstruction(defaultFilter, 'proposal_approve')).toBe(true);
		expect(allowsInstruction(defaultFilter, 'config_transaction_create')).toBe(true);
	});

	it('explicit instruction_types filters', () => {
		const f: NotificationFilter = {
			instructionTypes: ['proposal_approve', 'proposal_reject'],
			configTypes: [],
		};
		expect(allowsInstruction(f, 'proposal_approve')).toBe(true);
		expect(allowsInstruction(f, 'proposal_reject')).toBe(true);
		expect(allowsInstruction(f, 'proposal_create')).toBe(false);
	});

	it('empty config_types passes all actions', () => {
		const op = applyFilter(defaultFilter, {
			kind: 'config_transaction_create',
			actions: [
				{ kind: 'add_member', member: 'a', permissions: { mask: 7 } },
				{ kind: 'change_threshold', newThreshold: 2 },
			],
		});
		expect(op).not.toBeNull();
		if (op?.kind === 'config_transaction_create') {
			expect(op.actions).toHaveLength(2);
		}
	});

	it('explicit config_types filters actions', () => {
		const f: NotificationFilter = {
			instructionTypes: [],
			configTypes: ['add_member'],
		};
		const op = applyFilter(f, {
			kind: 'config_transaction_create',
			actions: [
				{ kind: 'add_member', member: 'a', permissions: { mask: 7 } },
				{ kind: 'change_threshold', newThreshold: 2 },
			],
		});
		expect(op).not.toBeNull();
		if (op?.kind === 'config_transaction_create') {
			expect(op.actions).toHaveLength(1);
			expect(op.actions[0]!.kind).toBe('add_member');
		}
	});

	it('suppresses when all actions filtered out', () => {
		const f: NotificationFilter = {
			instructionTypes: [],
			configTypes: ['set_time_lock'],
		};
		const op = applyFilter(f, {
			kind: 'config_transaction_create',
			actions: [{ kind: 'add_member', member: 'a', permissions: { mask: 7 } }],
		});
		expect(op).toBeNull();
	});

	it('non-config operations pass through', () => {
		const f: NotificationFilter = {
			instructionTypes: [],
			configTypes: ['add_member'],
		};
		const op = applyFilter(f, { kind: 'proposal_approve' });
		expect(op).toEqual({ kind: 'proposal_approve' });
	});

	it('validates valid types', () => {
		expect(() =>
			validateFilter({
				instructionTypes: ['proposal_approve', 'config_transaction_create'],
				configTypes: ['add_member'],
			})
		).not.toThrow();
	});

	it('rejects unknown instruction type', () => {
		expect(() => validateFilter({ instructionTypes: ['not_real'], configTypes: [] })).toThrow(
			'not_real'
		);
	});

	it('rejects unknown config type', () => {
		expect(() => validateFilter({ instructionTypes: [], configTypes: ['bogus'] })).toThrow(
			'bogus'
		);
	});
});

describe('parseCommaList', () => {
	it('parses basic list', () => {
		expect(parseCommaList('a, b')).toEqual(['a', 'b']);
	});

	it('returns empty for empty string', () => {
		expect(parseCommaList('')).toEqual([]);
	});

	it('trims whitespace', () => {
		expect(parseCommaList('  a , b  ')).toEqual(['a', 'b']);
	});
});
