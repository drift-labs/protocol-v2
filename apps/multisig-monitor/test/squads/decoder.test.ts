import bs58 from 'bs58';
import { buildOperation } from '../../src/squads/decoder';
import { getDiscriminatorMap } from '../../src/squads/discriminator';

/** Helper: creates instruction data with the correct discriminator for a given kind. */
async function makeInstructionData(
	kind: string,
	argsBytes: Uint8Array = new Uint8Array(0)
): Promise<Uint8Array> {
	const map = await getDiscriminatorMap();
	let discHex: string | undefined;
	for (const [hex, k] of map) {
		if (k === kind) {
			discHex = hex;
			break;
		}
	}
	if (!discHex) throw new Error(`unknown kind: ${kind}`);

	const disc = new Uint8Array(8);
	for (let i = 0; i < 8; i++) {
		disc[i] = parseInt(discHex.slice(i * 2, i * 2 + 2), 16);
	}

	const data = new Uint8Array(8 + argsBytes.length);
	data.set(disc, 0);
	data.set(argsBytes, 8);
	return data;
}

describe('decoder', () => {
	it('decodes config_transaction_create with ChangeThreshold', async () => {
		// Vec length (4 bytes LE) = 1
		// ConfigAction variant (1 byte) = 2 (ChangeThreshold)
		// new_threshold (2 bytes LE) = 3
		// memo: Option<String> = None (1 byte = 0)
		const args = new Uint8Array([1, 0, 0, 0, 2, 3, 0, 0]);
		const data = await makeInstructionData('config_transaction_create', args);
		const op = buildOperation('config_transaction_create', data);
		expect(op).not.toBeNull();
		expect(op!.kind).toBe('config_transaction_create');
		if (op!.kind === 'config_transaction_create') {
			expect(op!.actions).toHaveLength(1);
			expect(op!.actions[0]!.kind).toBe('change_threshold');
			if (op!.actions[0]!.kind === 'change_threshold') {
				expect(op!.actions[0]!.newThreshold).toBe(3);
			}
		}
	});

	it('decodes multisig_change_threshold', async () => {
		// Args: new_threshold (u16) = 5, memo = None
		const args = new Uint8Array([5, 0, 0]);
		const data = await makeInstructionData('multisig_change_threshold', args);
		const op = buildOperation('multisig_change_threshold', data);
		expect(op).not.toBeNull();
		if (op!.kind === 'multisig_change_threshold') {
			expect(op!.newThreshold).toBe(5);
		}
	});

	it('decodes multisig_add_member', async () => {
		// Args: Member { key: [42; 32], permissions: 0x03 }, memo = None
		const args = new Uint8Array(34);
		args.fill(42, 0, 32); // pubkey
		args[32] = 0x03; // permissions
		args[33] = 0; // memo = None
		const data = await makeInstructionData('multisig_add_member', args);
		const op = buildOperation('multisig_add_member', data);
		expect(op).not.toBeNull();
		if (op!.kind === 'multisig_add_member') {
			expect(op!.newMember.key).toBe(bs58.encode(new Uint8Array(32).fill(42)));
			expect(op!.newMember.permissions.mask).toBe(0x03);
		}
	});

	it('returns fallback on decode failure', async () => {
		// Provide too-short args for an instruction that decodes them
		const data = await makeInstructionData('multisig_change_threshold');
		const op = buildOperation('multisig_change_threshold', data);
		expect(op).not.toBeNull();
		if (op!.kind === 'multisig_change_threshold') {
			expect(op!.newThreshold).toBe(0); // fallback default
		}
	});

	it('returns fallback when a config action vec length exceeds remaining data', async () => {
		const args = new Uint8Array([2, 0, 0, 0]);
		const data = await makeInstructionData('config_transaction_create', args);
		const op = buildOperation('config_transaction_create', data);

		expect(op).toEqual({ kind: 'config_transaction_create', actions: [] });
	});

	it('returns fallback when a nested vec length exceeds remaining data', async () => {
		const args = new Uint8Array(4 + 1 + 32 + 1 + 32 + 8 + 1 + 4);
		let offset = 0;

		args.set([1, 0, 0, 0], offset);
		offset += 4;
		args[offset++] = 4;
		offset += 32;
		args[offset++] = 7;
		offset += 32;
		offset += 8;
		args[offset++] = 0;
		args.set([2, 0, 0, 0], offset);

		const data = await makeInstructionData('config_transaction_create', args);
		const op = buildOperation('config_transaction_create', data);

		expect(op).toEqual({ kind: 'config_transaction_create', actions: [] });
	});

	it('decodes simple instructions without args', async () => {
		const data = await makeInstructionData('proposal_approve');
		const op = buildOperation('proposal_approve', data);
		expect(op).toEqual({ kind: 'proposal_approve' });
	});
});
