import { buildPayload, buildBatchPayload, type DisplayConfig } from '../src/slack';
import type { DetectedOperation } from '../src/squads/types';
import type { SquadsOperation } from '../src/squads/types';

const defaultDisplay: DisplayConfig = {
	showPermissions: false,
	showTimestamps: false,
	truncateAddresses: false,
};

function makeOp(operation: SquadsOperation): DetectedOperation {
	return {
		signature:
			'5nNtjezQMYBHvgSQmoRmJPiXGsPAWmJPoGSa64xanqrauogiVzFyGQhKeFataHGXq51jR2hjbzNTkPUpP787HAmL',
		multisig: 'SMPLDaGKqbPfi8NhZMNGH2fRYU3WbNRZVj3xnTjEjXc',
		member: '9xKzmR2pLn4sHj7wBcDfAe8qYt6vXkZ3nPo1uWr5mQjS',
		transactionAddress: null,
		proposalAddress: null,
		operation,
		blockTime: null,
	};
}

describe('slack payload', () => {
	it('shows full addresses for proposal_approve', () => {
		const op = makeOp({ kind: 'proposal_approve' });
		const json = JSON.stringify(buildPayload(op, defaultDisplay));
		expect(json).toContain('SMPLDaGKqbPfi8NhZMNGH2fRYU3WbNRZVj3xnTjEjXc');
		expect(json).toContain('9xKzmR2pLn4sHj7wBcDfAe8qYt6vXkZ3nPo1uWr5mQjS');
		expect(json).toContain('*Multisig:* `SMPLDaGKqbPfi8NhZMNGH2fRYU3WbNRZVj3xnTjEjXc`');
		expect(json).toContain('*Approver:* `9xKzmR2pLn4sHj7wBcDfAe8qYt6vXkZ3nPo1uWr5mQjS`');
		expect(json).toContain('solscan.io');
	});

	it('includes config actions for config_transaction_create', () => {
		const op = makeOp({
			kind: 'config_transaction_create',
			actions: [
				{
					kind: 'add_member',
					member: 'HjK4NewMember567890abcdefghijklmnopqrstuv12',
					permissions: { mask: 0x06 },
				},
				{ kind: 'change_threshold', newThreshold: 3 },
			],
		});
		const json = JSON.stringify(buildPayload(op, defaultDisplay));
		expect(json).toContain('Config Transaction Created');
		expect(json).toContain('HjK4NewMember567890abcdefghijklmnopqrstuv12');
		expect(json).toContain('Change threshold to 3');
	});

	it('shows direct member added with permissions', () => {
		const op = makeOp({
			kind: 'multisig_add_member',
			newMember: {
				key: 'NewKeyABCDEF1234567890abcdefghijklmnopqrstuv',
				permissions: { mask: 0x07 },
			},
		});
		const json = JSON.stringify(buildPayload(op, defaultDisplay));
		expect(json).toContain('Direct: Member Added');
		expect(json).toContain('Config Authority');
		expect(json).toContain('Initiate, Vote, Execute');
	});

	it('includes transaction and proposal addresses', () => {
		const op: DetectedOperation = {
			...makeOp({ kind: 'vault_transaction_execute' }),
			transactionAddress: 'TxAddr1234567890abcdefghijklmnopqrstuvwxyz12',
			proposalAddress: 'PropAddr567890abcdefghijklmnopqrstuvwxyz1234',
		};
		const json = JSON.stringify(buildPayload(op, defaultDisplay));
		expect(json).toContain('TxAddr1234567890abcdefghijklmnopqrstuvwxyz12');
		expect(json).toContain('PropAddr567890abcdefghijklmnopqrstuvwxyz1234');
	});

	it('shows full signature in solscan link', () => {
		const op = makeOp({ kind: 'proposal_approve' });
		const json = JSON.stringify(buildPayload(op, defaultDisplay));
		const sig =
			'5nNtjezQMYBHvgSQmoRmJPiXGsPAWmJPoGSa64xanqrauogiVzFyGQhKeFataHGXq51jR2hjbzNTkPUpP787HAmL';
		expect(json).toContain(`solscan.io/tx/${sig}|${sig}`);
	});

	it('truncates addresses when configured', () => {
		const display: DisplayConfig = {
			...defaultDisplay,
			truncateAddresses: true,
		};
		const op = makeOp({ kind: 'proposal_approve' });
		const payload = buildPayload(op, display);
		const json = JSON.stringify(payload);
		// Truncated form present in display text
		expect(json).toContain('SMPL...EjXc');
		// Full address still present in code block
		expect(json).toContain('SMPLDaGKqbPfi8NhZMNGH2fRYU3WbNRZVj3xnTjEjXc');
	});

	it('shows timestamp when configured and blockTime present', () => {
		const display: DisplayConfig = { ...defaultDisplay, showTimestamps: true };
		const op: DetectedOperation = {
			...makeOp({ kind: 'proposal_approve' }),
			blockTime: 1712150400,
		};
		const payload = buildPayload(op, display);
		const json = JSON.stringify(payload);
		expect(json).toContain('*Time:*');
		expect(json).toContain('UTC');
	});

	it('buildBatchPayload combines multiple operations', () => {
		const op1 = makeOp({ kind: 'proposal_approve' });
		const op2 = makeOp({ kind: 'proposal_reject' });
		const payloads = buildBatchPayload([op1, op2], defaultDisplay);
		expect(payloads).toHaveLength(1);
		const json = JSON.stringify(payloads[0]);
		expect(json).toContain('Proposal Approved');
		expect(json).toContain('Proposal Rejected');
	});

	it('buildBatchPayload returns empty array for no operations', () => {
		expect(buildBatchPayload([], defaultDisplay)).toHaveLength(0);
	});
});
