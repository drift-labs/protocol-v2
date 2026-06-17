import bs58 from 'bs58';
import type { RawTransaction } from '../../src/webhook';
import { extractSignerEvents } from '../../src/signer/extractor';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const RECENT_BLOCKHASHES = 'SysvarRecentB1ockHashes11111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

// Real wallets from the Drift incident, used as canonical fixtures.
const COUNCIL = '39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8';
const ATTACKER_FUNDER = 'FMJnBkVpHj5JzN7w4XFysCwY931CYSYk1DsXzqNi7YPF';
const NONCE_ACCOUNT = '7s7s6saC5LHZoLyBXLM3pCjpWaA7meyQdP8NiH9ktAeC';
const UNRELATED = '9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Build a base58-encoded SystemProgram::InitializeNonceAccount data blob. */
function initializeNonceData(authority: string): string {
	const authBytes = bs58.decode(authority);
	if (authBytes.length !== 32) throw new Error('bad authority pubkey');
	const buf = Buffer.alloc(4 + 32);
	buf.writeUInt32LE(6, 0); // variant 6 = InitializeNonceAccount
	Buffer.from(authBytes).copy(buf, 4);
	return bs58.encode(buf);
}

function makeTx(opts: {
	signature: string;
	signers: string[];
	accountKeys: string[];
	instructions: { programIdIndex: number; accounts: number[]; data: string }[];
	err?: unknown;
}): RawTransaction {
	return {
		signature: opts.signature,
		blockTime: 1_775_000_000,
		transaction: {
			signatures: opts.signers.map(() => 'sig'),
			message: {
				accountKeys: opts.accountKeys.map((k, i) => ({
					pubkey: k,
					signer: i < opts.signers.length,
					writable: true,
				})),
				instructions: opts.instructions,
			},
		},
		meta: opts.err === undefined ? { err: null } : { err: opts.err },
	};
}

describe('extractSignerEvents', () => {
	it('returns empty when monitoredSigners is empty', () => {
		const tx = makeTx({
			signature: 'sig1',
			signers: [COUNCIL],
			accountKeys: [COUNCIL, NONCE_ACCOUNT, RECENT_BLOCKHASHES, RENT_SYSVAR, SYSTEM_PROGRAM],
			instructions: [
				{
					programIdIndex: 4,
					accounts: [1, 2, 3],
					data: initializeNonceData(COUNCIL),
				},
			],
		});
		expect(extractSignerEvents([tx], [])).toEqual([]);
	});

	it('flags the actual Drift-style attack: attacker funds, council member is authority', () => {
		const tx = makeTx({
			signature: 'sig-real-attack',
			signers: [ATTACKER_FUNDER],
			accountKeys: [
				ATTACKER_FUNDER,
				NONCE_ACCOUNT,
				SYSTEM_PROGRAM,
				RECENT_BLOCKHASHES,
				RENT_SYSVAR,
			],
			instructions: [
				{
					programIdIndex: 2,
					accounts: [1, 3, 4],
					data: initializeNonceData(COUNCIL),
				},
			],
		});

		const events = extractSignerEvents([tx], [COUNCIL]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			signature: 'sig-real-attack',
			kind: 'nonce_account_targeting_signer',
			targetedSigner: COUNCIL,
			funder: ATTACKER_FUNDER,
			nonceAccount: NONCE_ACCOUNT,
		});
	});

	it('also flags self-funded creation (council member creates their own nonce)', () => {
		const tx = makeTx({
			signature: 'sig-self',
			signers: [COUNCIL],
			accountKeys: [COUNCIL, NONCE_ACCOUNT, SYSTEM_PROGRAM, RECENT_BLOCKHASHES, RENT_SYSVAR],
			instructions: [
				{
					programIdIndex: 2,
					accounts: [1, 3, 4],
					data: initializeNonceData(COUNCIL),
				},
			],
		});
		const events = extractSignerEvents([tx], [COUNCIL]);
		expect(events).toHaveLength(1);
		expect(events[0]!.funder).toBe(COUNCIL);
		expect(events[0]!.targetedSigner).toBe(COUNCIL);
	});

	it('ignores InitializeNonceAccount when authority is not in the watched list', () => {
		const tx = makeTx({
			signature: 'sig',
			signers: [ATTACKER_FUNDER],
			accountKeys: [
				ATTACKER_FUNDER,
				NONCE_ACCOUNT,
				SYSTEM_PROGRAM,
				RECENT_BLOCKHASHES,
				RENT_SYSVAR,
				UNRELATED,
			],
			instructions: [
				{
					programIdIndex: 2,
					accounts: [1, 3, 4],
					data: initializeNonceData(UNRELATED),
				},
			],
		});
		expect(extractSignerEvents([tx], [COUNCIL])).toEqual([]);
	});

	it('ignores AdvanceNonce (variant 4) and other non-init system instructions', () => {
		const advanceNonceData = (() => {
			const buf = Buffer.alloc(4);
			buf.writeUInt32LE(4, 0);
			return bs58.encode(buf);
		})();
		const tx = makeTx({
			signature: 'sig',
			signers: [COUNCIL],
			accountKeys: [COUNCIL, NONCE_ACCOUNT, RECENT_BLOCKHASHES, SYSTEM_PROGRAM],
			instructions: [
				{
					programIdIndex: 3,
					accounts: [1, 2, 0],
					data: advanceNonceData,
				},
			],
		});
		expect(extractSignerEvents([tx], [COUNCIL])).toEqual([]);
	});

	it('skips failed transactions', () => {
		const tx = makeTx({
			signature: 'sig',
			signers: [ATTACKER_FUNDER],
			accountKeys: [
				ATTACKER_FUNDER,
				NONCE_ACCOUNT,
				SYSTEM_PROGRAM,
				RECENT_BLOCKHASHES,
				RENT_SYSVAR,
			],
			instructions: [
				{
					programIdIndex: 2,
					accounts: [1, 3, 4],
					data: initializeNonceData(COUNCIL),
				},
			],
			err: { InstructionError: [0, 'Custom'] },
		});
		expect(extractSignerEvents([tx], [COUNCIL])).toEqual([]);
	});

	it('scans inner instructions too', () => {
		const tx: RawTransaction = {
			signature: 'sig-inner',
			blockTime: 1_775_000_000,
			transaction: {
				signatures: ['sig'],
				message: {
					accountKeys: [
						{ pubkey: ATTACKER_FUNDER, signer: true, writable: true },
						{ pubkey: NONCE_ACCOUNT, signer: false, writable: true },
						{ pubkey: SYSTEM_PROGRAM, signer: false, writable: false },
						{ pubkey: RECENT_BLOCKHASHES, signer: false, writable: false },
						{ pubkey: RENT_SYSVAR, signer: false, writable: false },
					],
					instructions: [{ programIdIndex: 2, accounts: [], data: '00' }],
				},
			},
			meta: {
				err: null,
				innerInstructions: [
					{
						index: 0,
						instructions: [
							{
								programIdIndex: 2,
								accounts: [1, 3, 4],
								data: initializeNonceData(COUNCIL),
							},
						],
					},
				],
			},
		};
		const events = extractSignerEvents([tx], [COUNCIL]);
		expect(events).toHaveLength(1);
		expect(events[0]!.funder).toBe(ATTACKER_FUNDER);
	});
});
