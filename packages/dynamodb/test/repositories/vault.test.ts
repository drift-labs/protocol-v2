import {
	EntityTypes,
	IngestionSource,
	VaultDepositorCumulativeRecord,
	VaultDepositorRecord,
} from '@backend/common';
import { VaultRepository } from '../../src/repositories/vault';

const mockBatchWrite = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockQueryAll = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		get: mockGet,
		update: mockUpdate,
		queryAll: mockQueryAll,
	}),
}));

describe('VaultRepository', () => {
	const {
		createVaultDepositRecords,
		getVaultCumulativeRecord,
		getVaultDepositRecordsBetweenTimestamps,
	} = VaultRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	const baseDepositRecord: VaultDepositorRecord = {
		ts: 1742345769,
		txSig: 'txSig-1',
		txSigIndex: 10,
		slot: 327680913,
		vault: 'vault-1',
		depositorAuthority: 'auth-1',
		action: 'deposit',
		amount: 1338.968718,
		spotMarketIndex: 0,
		vaultSharesBefore: 5805885632,
		vaultSharesAfter: 6952668895,
		vaultEquityBefore: 1772849316095,
		userVaultSharesBefore: 1463780160728,
		totalVaultSharesBefore: 1518387917723,
		userVaultSharesAfter: 1464926943991,
		totalVaultSharesAfter: 1519534700986,
		profitShare: 0,
		managementFee: 0,
		managementFeeShares: 0,
		depositOraclePrice: 1,
		source: IngestionSource.SEQUENTIAL,
		entity: EntityTypes.User,
	};

	describe('createVaultDepositRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			mockBatchWrite.mockResolvedValue([]);
			mockUpdate.mockResolvedValue({});

			const records: VaultDepositorRecord[] = [baseDepositRecord as VaultDepositorRecord];

			await createVaultDepositRecords(records);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'AUTHORITY#auth-1',
						sk: 'VAULT_DEPOSIT#VAULT#vault-1#TS#1742345769#SLOT#327680913#SIG#txSig-1#INDEX#00010',
						createdAt: expect.any(Number),
						...baseDepositRecord,
					},
				],
			});
		});

		it('should update cumulative records for deposits', async () => {
			mockBatchWrite.mockResolvedValue([]);
			mockUpdate.mockResolvedValue({});

			const records: VaultDepositorRecord[] = [baseDepositRecord as VaultDepositorRecord];

			await createVaultDepositRecords(records);

			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenNthCalledWith(1, {
				pk: 'AUTHORITY#auth-1',
				sk: 'CUMULATIVE_VAULT_DEPOSIT#VAULT#vault-1',
				updateExpression: expect.stringContaining(
					'ADD cumulativeDepositQuoteValue :depositIncrement'
				),
				conditionExpression: 'NOT contains(processedTransactions, :txId)',
				expressionValues: {
					':depositIncrement': 1338.968718,
					':withdrawalIncrement': 0,
					':emptyList': [],
					':tx': ['txSig-1-10'],
					':txId': 'txSig-1-10',
				},
			});

			expect(mockUpdate).toHaveBeenNthCalledWith(2, {
				pk: 'AUTHORITY#auth-1',
				sk: 'CUMULATIVE_VAULT_DEPOSIT',
				updateExpression: expect.stringContaining(
					'ADD cumulativeDepositQuoteValue :depositIncrement'
				),
				conditionExpression: 'NOT contains(processedTransactions, :txId)',
				expressionValues: {
					':depositIncrement': 1338.968718,
					':withdrawalIncrement': 0,
					':emptyList': [],
					':tx': ['txSig-1-10'],
					':txId': 'txSig-1-10',
				},
			});
		});

		it('should update cumulative records for withdrawals', async () => {
			mockBatchWrite.mockResolvedValue([]);
			mockUpdate.mockResolvedValue({});

			const withdrawalRecord = {
				...baseDepositRecord,
				action: 'withdraw',
			};

			const records: VaultDepositorRecord[] = [withdrawalRecord as VaultDepositorRecord];

			await createVaultDepositRecords(records);

			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					expressionValues: expect.objectContaining({
						':depositIncrement': 0,
						':withdrawalIncrement': 1338.968718,
					}),
				})
			);
		});

		it('should skip updates for non-deposit/withdraw actions', async () => {
			mockBatchWrite.mockResolvedValue([]);
			mockUpdate.mockResolvedValue({});

			const invalidActionRecord = {
				...baseDepositRecord,
				action: 'other',
			};

			const records: VaultDepositorRecord[] = [invalidActionRecord as VaultDepositorRecord];

			await createVaultDepositRecords(records);

			expect(mockUpdate).not.toHaveBeenCalled();
			expect(mockBatchWrite).toHaveBeenCalled();
		});

		it('should handle multiple records', async () => {
			mockBatchWrite.mockResolvedValue([]);
			mockUpdate.mockResolvedValue({});

			const secondRecord = {
				...baseDepositRecord,
				depositorAuthority: 'auth-2',
				vault: 'vault-2',
				action: 'withdraw',
				txSig: 'sig456',
			};

			const records: VaultDepositorRecord[] = [
				baseDepositRecord as VaultDepositorRecord,
				secondRecord as VaultDepositorRecord,
			];

			await createVaultDepositRecords(records);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: expect.arrayContaining([
					expect.objectContaining({ depositorAuthority: 'auth-1' }),
					expect.objectContaining({ depositorAuthority: 'auth-2' }),
				]),
			});

			expect(mockUpdate).toHaveBeenCalledTimes(4);
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ error: 'Write failed' }];
			mockBatchWrite.mockResolvedValue(failedItems);
			mockUpdate.mockResolvedValue({});

			const records: VaultDepositorRecord[] = [baseDepositRecord as VaultDepositorRecord];

			const result = await createVaultDepositRecords(records);
			expect(result).toBe(failedItems);
		});
	});

	describe('getVaultCumulativeRecord', () => {
		it('should call get with correct parameters when vault is provided', async () => {
			const mockCumulativeRecord: Partial<VaultDepositorCumulativeRecord> = {
				cumulativeDepositQuoteValue: 5000,
				cumulativeWithdrawalQuoteValue: 1000,
				processedTransactions: ['sig123-1', 'sig456-1'],
			};

			mockGet.mockResolvedValue({ Item: mockCumulativeRecord });

			const result = await getVaultCumulativeRecord({
				authority: 'auth1',
				vault: 'vault1',
			});

			delete mockCumulativeRecord.processedTransactions;

			expect(mockGet).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				sk: 'CUMULATIVE_VAULT_DEPOSIT#VAULT#vault1',
			});

			expect(result).toEqual(mockCumulativeRecord);
		});

		it('should call get with correct parameters when vault is not provided', async () => {
			const mockCumulativeRecord: Partial<VaultDepositorCumulativeRecord> = {
				cumulativeDepositQuoteValue: 10000,
				cumulativeWithdrawalQuoteValue: 2000,
				processedTransactions: ['sig123-1', 'sig456-1', 'sig789-1'],
			};

			mockGet.mockResolvedValue({ Item: mockCumulativeRecord });

			const result = await getVaultCumulativeRecord({
				authority: 'auth1',
			});

			delete mockCumulativeRecord.processedTransactions;

			expect(mockGet).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				sk: 'CUMULATIVE_VAULT_DEPOSIT',
			});
			expect(result).toEqual(mockCumulativeRecord);
		});

		it('should handle case when no record is found', async () => {
			mockGet.mockResolvedValue({ Item: null });

			const result = await getVaultCumulativeRecord({
				authority: 'auth1',
				vault: 'vault1',
			});

			expect(result).toBeNull();
		});
	});

	describe('getVaultDepositRecordsBetweenTimestamps', () => {
		it('should call queryAll with correct parameters', async () => {
			const mockRecords = [
				{ ...baseDepositRecord },
				{
					...baseDepositRecord,
					ts: 1742345800,
					txSig: 'txSig-2',
					sk: 'VAULT_DEPOSIT#VAULT#vault-1#TS#1742345800#SLOT#327680950#SIG#txSig-2#INDEX#00010',
				},
			];

			mockQueryAll.mockResolvedValue(mockRecords);

			const startTs = 1742345700;
			const endTs = 1742345900;
			const result = await getVaultDepositRecordsBetweenTimestamps({
				authority: 'auth-1',
				id: 'vault-1',
				startTs,
				endTs,
			});

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth-1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'AUTHORITY#auth-1',
					':startSk': 'VAULT_DEPOSIT#VAULT#vault-1#TS#1742345700',
					':endSk': 'VAULT_DEPOSIT#VAULT#vault-1#TS#1742345900',
				},
			});

			expect(result).toEqual(mockRecords);
		});

		it('should return empty array when no records found', async () => {
			mockQueryAll.mockResolvedValue([]);

			const result = await getVaultDepositRecordsBetweenTimestamps({
				authority: 'auth-1',
				id: 'auth-1',
				startTs: 1742345700,
				endTs: 1742345900,
			});

			expect(result).toEqual([]);
		});
	});
});
