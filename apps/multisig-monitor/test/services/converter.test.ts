import bs58 from 'bs58';
import {
	yellowstoneToRawTransaction,
	type YellowstoneTransaction,
} from '../../src/services/converter';
import { getDiscriminatorMap } from '../../src/squads/discriminator';
import { extractOperations } from '../../src/squads';

const SQUADS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const MULTISIG = 'SMPLDaGKqbPfi8NhZMNGH2fRYU3WbNRZVj3xnTjEjXc';
const MEMBER = '9xKzmR2pLn4sHj7wBcDfAe8qYt6vXkZ3nPo1uWr5mQjS';
const LOADED_WRITABLE = bs58.encode(new Uint8Array(32).fill(0x11));
const LOADED_READONLY = bs58.encode(new Uint8Array(32).fill(0x22));

const SIGNATURE_BYTES = new Uint8Array(64).fill(7);
const SIGNATURE_B58 = bs58.encode(SIGNATURE_BYTES);

function pubkeyBytes(b58: string): Uint8Array {
	return Uint8Array.from(bs58.decode(b58));
}

/**
 * Builds a minimal SubscribeUpdate (carrying a transaction) that matches the
 * Yellowstone protobuf shape closely enough for the converter to traverse.
 * Optional fields default to plausible, success values.
 */
function makeUpdate(opts: {
	staticAccountKeys: string[];
	loadedWritable?: string[];
	loadedReadonly?: string[];
	instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
	innerInstructions?: {
		index: number;
		instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
	}[];
	logMessages?: string[];
	logMessagesNone?: boolean;
	err?: { err: Uint8Array };
	slot?: bigint;
}): YellowstoneTransaction {
	return {
		filters: [],
		createdAt: undefined,
		transaction: {
			slot: opts.slot ?? 1234n,
			transaction: {
				signature: SIGNATURE_BYTES,
				isVote: false,
				index: 0n,
				transaction: {
					signatures: [SIGNATURE_BYTES],
					message: {
						header: {
							numRequiredSignatures: 1,
							numReadonlySignedAccounts: 0,
							numReadonlyUnsignedAccounts: 1,
						},
						accountKeys: opts.staticAccountKeys.map(pubkeyBytes),
						recentBlockhash: new Uint8Array(32),
						instructions: opts.instructions.map((ix) => ({
							programIdIndex: ix.programIdIndex,
							accounts: Uint8Array.from(ix.accounts),
							data: ix.data,
						})),
						versioned:
							(opts.loadedWritable?.length ?? 0) +
								(opts.loadedReadonly?.length ?? 0) >
							0,
						addressTableLookups: [],
					},
				},
				meta: {
					err: opts.err,
					fee: 5000n,
					preBalances: [],
					postBalances: [],
					innerInstructions: (opts.innerInstructions ?? []).map((set) => ({
						index: set.index,
						instructions: set.instructions.map((ix) => ({
							programIdIndex: ix.programIdIndex,
							accounts: Uint8Array.from(ix.accounts),
							data: ix.data,
						})),
					})),
					innerInstructionsNone: false,
					logMessages: opts.logMessages ?? [],
					logMessagesNone: opts.logMessagesNone ?? false,
					preTokenBalances: [],
					postTokenBalances: [],
					rewards: [],
					loadedWritableAddresses: (opts.loadedWritable ?? []).map(pubkeyBytes),
					loadedReadonlyAddresses: (opts.loadedReadonly ?? []).map(pubkeyBytes),
					returnData: undefined,
					returnDataNone: true,
					computeUnitsConsumed: 0n,
					costUnits: 0n,
				} as any,
			},
		},
	};
}

describe('yellowstoneToRawTransaction', () => {
	it('converts a basic transaction with one instruction', () => {
		const update = makeUpdate({
			staticAccountKeys: [MEMBER, MULTISIG, SQUADS],
			instructions: [
				{
					programIdIndex: 2,
					accounts: [1, 0],
					data: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
				},
			],
			logMessages: [`Program ${SQUADS} invoke [1]`, `Program ${SQUADS} success`],
		});

		const raw = yellowstoneToRawTransaction(update);
		expect(raw).not.toBeNull();
		expect(raw!.signature).toBe(SIGNATURE_B58);
		expect(raw!.slot).toBe(1234);
		expect(raw!.transaction.signatures).toEqual([SIGNATURE_B58]);
		expect(raw!.transaction.message.accountKeys).toEqual([MEMBER, MULTISIG, SQUADS]);
		expect(raw!.transaction.message.instructions).toEqual([
			{
				programIdIndex: 2,
				accounts: [1, 0],
				data: bs58.encode(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])),
			},
		]);
		expect(raw!.meta?.err).toBeUndefined();
		expect(raw!.meta?.logMessages).toEqual([
			`Program ${SQUADS} invoke [1]`,
			`Program ${SQUADS} success`,
		]);
	});

	it('appends loaded writable then loaded readonly addresses to accountKeys (v0 tx)', () => {
		const update = makeUpdate({
			staticAccountKeys: [MEMBER, MULTISIG, SQUADS],
			loadedWritable: [LOADED_WRITABLE],
			loadedReadonly: [LOADED_READONLY],
			// Instruction references index 3 = first loaded writable, index 4 = loaded readonly
			instructions: [
				{
					programIdIndex: 2,
					accounts: [3, 4],
					data: new Uint8Array([0]),
				},
			],
		});

		const raw = yellowstoneToRawTransaction(update);
		expect(raw!.transaction.message.accountKeys).toEqual([
			MEMBER,
			MULTISIG,
			SQUADS,
			LOADED_WRITABLE,
			LOADED_READONLY,
		]);
		// Instruction account indices stay as-is — they already reference the
		// expanded accountKeys layout.
		expect(raw!.transaction.message.instructions[0]!.accounts).toEqual([3, 4]);
	});

	it('preserves inner instructions and their account/data shapes', () => {
		const update = makeUpdate({
			staticAccountKeys: [MEMBER, MULTISIG, SQUADS, '11111111111111111111111111111111'],
			instructions: [{ programIdIndex: 2, accounts: [1, 0], data: new Uint8Array([0]) }],
			innerInstructions: [
				{
					index: 0,
					instructions: [
						{
							programIdIndex: 3,
							accounts: [0, 1, 2],
							data: Uint8Array.from([1, 2, 3]),
						},
					],
				},
			],
		});

		const raw = yellowstoneToRawTransaction(update);
		expect(raw!.meta?.innerInstructions).toEqual([
			{
				index: 0,
				instructions: [
					{
						programIdIndex: 3,
						accounts: [0, 1, 2],
						data: bs58.encode(Uint8Array.from([1, 2, 3])),
					},
				],
			},
		]);
	});

	it('passes through err for failed transactions', () => {
		const update = makeUpdate({
			staticAccountKeys: [MEMBER, SQUADS],
			instructions: [{ programIdIndex: 1, accounts: [0], data: new Uint8Array(0) }],
			err: { err: Uint8Array.from([1, 0, 0, 0]) },
		});
		const raw = yellowstoneToRawTransaction(update);
		expect(raw!.meta?.err).toBeDefined();
	});

	it('returns undefined logMessages when logMessagesNone is true', () => {
		const update = makeUpdate({
			staticAccountKeys: [MEMBER, SQUADS],
			instructions: [{ programIdIndex: 1, accounts: [0], data: new Uint8Array(0) }],
			logMessagesNone: true,
			logMessages: [],
		});
		const raw = yellowstoneToRawTransaction(update);
		expect(raw!.meta?.logMessages).toBeUndefined();
	});

	it('returns null when transaction or message is missing', () => {
		// No transaction wrapper at all
		expect(
			yellowstoneToRawTransaction({
				filters: [],
				createdAt: undefined,
				transaction: undefined,
			} as any)
		).toBeNull();
		// Wrapper present but inner transaction undefined
		expect(
			yellowstoneToRawTransaction({
				filters: [],
				createdAt: undefined,
				transaction: {
					slot: 1n,
					transaction: {
						signature: new Uint8Array(64),
						isVote: false,
						index: 0n,
						transaction: undefined,
						meta: undefined,
					},
				},
			} as any)
		).toBeNull();
	});

	it('round-trips through extractOperations on a Squads instruction', async () => {
		// Discriminator for proposal_approve
		const map = await getDiscriminatorMap();
		let approveDiscHex: string | undefined;
		for (const [hex, kind] of map) {
			if (kind === 'proposal_approve') {
				approveDiscHex = hex;
				break;
			}
		}
		const disc = new Uint8Array(8);
		for (let i = 0; i < 8; i++) {
			disc[i] = parseInt(approveDiscHex!.slice(i * 2, i * 2 + 2), 16);
		}

		// proposal_approve account layout: [multisig=0, member=1, proposal=2]
		const PROPOSAL = 'PrPoooooooooooooooooooooooooooooooooooooooo';
		const update = makeUpdate({
			staticAccountKeys: [MULTISIG, MEMBER, PROPOSAL, SQUADS],
			instructions: [
				{
					programIdIndex: 3,
					accounts: [0, 1, 2],
					data: disc,
				},
			],
		});

		const raw = yellowstoneToRawTransaction(update);
		const ops = await extractOperations([raw!], [MULTISIG], {
			instructionTypes: [],
			configTypes: [],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			signature: SIGNATURE_B58,
			multisig: MULTISIG,
			member: MEMBER,
			proposalAddress: PROPOSAL,
			operation: { kind: 'proposal_approve' },
		});
	});
});
