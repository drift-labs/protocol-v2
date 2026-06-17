import { enrichLayer1 } from '../../src/squads/enrich';
import { SQUADS_PROGRAM_ID } from '../../src/squads/types';

const DRIFT = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const SYS = '11111111111111111111111111111111';

describe('enrichLayer1', () => {
	it('returns empty when there are no inner instructions', () => {
		const result = enrichLayer1([], ['a', 'b'], ['Program X invoke [1]']);
		expect(result.innerCpis).toEqual([]);
	});

	it('resolves program id and accounts via accountKeys', () => {
		const accountKeys = ['payer', DRIFT, 'acct1', 'acct2'];
		const result = enrichLayer1(
			[{ programIdIndex: 1, accounts: [2, 3, 0], data: 'ABC' }],
			accountKeys,
			undefined
		);
		expect(result.innerCpis).toHaveLength(1);
		expect(result.innerCpis[0]).toMatchObject({
			programId: DRIFT,
			accounts: ['acct1', 'acct2', 'payer'],
			dataB58: 'ABC',
			instructionName: null,
			programLogs: [],
		});
	});

	it('attributes Anchor instruction name and program logs to the matching CPI', () => {
		const accountKeys = ['payer', SQUADS_PROGRAM_ID, DRIFT];
		const logs = [
			`Program ${SQUADS_PROGRAM_ID} invoke [1]`,
			'Program log: Instruction: VaultTransactionExecute',
			`Program ${DRIFT} invoke [2]`,
			'Program log: Instruction: UpdateAdmin',
			'Program log: admin: oldKey -> newKey',
			`Program ${DRIFT} success`,
			`Program ${SQUADS_PROGRAM_ID} success`,
		];
		const result = enrichLayer1(
			[{ programIdIndex: 2, accounts: [], data: 'data' }],
			accountKeys,
			logs
		);
		expect(result.innerCpis).toHaveLength(1);
		const cpi = result.innerCpis[0]!;
		expect(cpi.programId).toBe(DRIFT);
		expect(cpi.instructionName).toBe('UpdateAdmin');
		expect(cpi.programLogs).toEqual(['admin: oldKey -> newKey']);
	});

	it('zips multiple CPIs with their respective log blocks in order', () => {
		const accountKeys = ['payer', SQUADS_PROGRAM_ID, DRIFT, SYS];
		const logs = [
			`Program ${SQUADS_PROGRAM_ID} invoke [1]`,
			'Program log: Instruction: VaultTransactionExecute',
			`Program ${DRIFT} invoke [2]`,
			'Program log: Instruction: UpdatePerpMarketContractTier',
			'Program log: market: 0',
			`Program ${DRIFT} success`,
			`Program ${SYS} invoke [2]`,
			`Program ${SYS} success`,
			`Program ${SQUADS_PROGRAM_ID} success`,
		];
		const result = enrichLayer1(
			[
				{ programIdIndex: 2, accounts: [], data: 'drift-data' },
				{ programIdIndex: 3, accounts: [], data: 'sys-data' },
			],
			accountKeys,
			logs
		);
		expect(result.innerCpis).toHaveLength(2);
		expect(result.innerCpis[0]).toMatchObject({
			programId: DRIFT,
			instructionName: 'UpdatePerpMarketContractTier',
			programLogs: ['market: 0'],
		});
		expect(result.innerCpis[1]).toMatchObject({
			programId: SYS,
			instructionName: null,
			programLogs: [],
		});
	});

	it('captures logs from deeper nested CPIs against the outer ancestor', () => {
		const accountKeys = ['payer', SQUADS_PROGRAM_ID, DRIFT, 'BPFLoader'];
		const logs = [
			`Program ${SQUADS_PROGRAM_ID} invoke [1]`,
			'Program log: Instruction: VaultTransactionExecute',
			`Program ${DRIFT} invoke [2]`,
			'Program log: Instruction: UpdateAdmin',
			`Program BPFLoader invoke [3]`,
			'Program log: nested log',
			`Program BPFLoader success`,
			`Program ${DRIFT} success`,
			`Program ${SQUADS_PROGRAM_ID} success`,
		];
		const result = enrichLayer1(
			[{ programIdIndex: 2, accounts: [], data: 'data' }],
			accountKeys,
			logs
		);
		expect(result.innerCpis[0]!.programLogs).toContain('nested log');
	});

	it('handles missing logMessages gracefully', () => {
		const accountKeys = ['payer', DRIFT];
		const result = enrichLayer1(
			[{ programIdIndex: 1, accounts: [0], data: 'x' }],
			accountKeys,
			undefined
		);
		expect(result.innerCpis[0]).toMatchObject({
			programId: DRIFT,
			instructionName: null,
			programLogs: [],
		});
	});

	it('handles failed inner CPI without crashing', () => {
		const accountKeys = ['payer', SQUADS_PROGRAM_ID, DRIFT];
		const logs = [
			`Program ${SQUADS_PROGRAM_ID} invoke [1]`,
			'Program log: Instruction: VaultTransactionExecute',
			`Program ${DRIFT} invoke [2]`,
			'Program log: Instruction: UpdateAdmin',
			`Program ${DRIFT} failed: custom program error: 0x1`,
			`Program ${SQUADS_PROGRAM_ID} failed: custom program error: 0x1`,
		];
		const result = enrichLayer1(
			[{ programIdIndex: 2, accounts: [], data: 'data' }],
			accountKeys,
			logs
		);
		expect(result.innerCpis[0]!.instructionName).toBe('UpdateAdmin');
	});

	it("uses 'unknown' for out-of-range account indices", () => {
		const accountKeys = ['payer', DRIFT];
		const result = enrichLayer1(
			[{ programIdIndex: 1, accounts: [0, 99], data: 'x' }],
			accountKeys,
			undefined
		);
		expect(result.innerCpis[0]!.accounts).toEqual(['payer', 'unknown']);
	});
});
