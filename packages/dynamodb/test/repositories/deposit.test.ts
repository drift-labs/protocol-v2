import { DepositRecord, EntityTypes, IngestionSource } from '@backend/common';
import { DepositRepository } from '../../src/repositories/deposit';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('DepositRepository', () => {
	const { createDepositRecords, getDepositRecords, getDepositRecordsBetweenTimestamps } =
		DepositRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createDepositRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<DepositRecord>[] = [
				{
					user: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 1,
					entity: EntityTypes.User,
					symbol: 'USDC',
					source: IngestionSource.SEQUENTIAL,
					amount: 100,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					symbol: 'SOL',
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
					amount: 200,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					symbol: 'SOL',
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Market,
					amount: 200,
				},
			];

			await createDepositRecords(records as DepositRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'DEPOSIT#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						GSI1PK: 'USER#user1',
						GSI1SK: 'DEPOSIT#MARKET#USDC#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						user: 'user1',
						symbol: 'USDC',
						slot: 123,
						ts: 1234567890,
						txSig: '123',
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.User,
						amount: 100,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'USER#user2',
						sk: 'DEPOSIT#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						GSI1PK: 'USER#user2',
						GSI1SK: 'DEPOSIT#MARKET#SOL#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						symbol: 'SOL',
						slot: 124,
						ts: 1234567891,
						txSig: '123',
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.User,
						amount: 200,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'MARKET#SOL',
						sk: 'DEPOSIT#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						symbol: 'SOL',
						slot: 124,
						ts: 1234567891,
						txSig: '123',
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.Market,
						amount: 200,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<DepositRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
					amount: 100,
				},
			];

			const result = await createDepositRecords(records as DepositRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getDepositRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'testUser';
			await getDepositRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'DEPOSIT',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ id: '1', amount: 100 },
				{ id: '2', amount: 200 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#testUser', sk: 'DEPOSIT#TS#1234567890' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getDepositRecords({ id: 'testUser' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'testUser';
			const page = { pk: 'USER#testUser', sk: 'DEPOSIT#TS#1500000000' };
			await getDepositRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'DEPOSIT',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getDepositRecords({ id: 'testUser' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getDepositRecordsBetweenTimestamps', () => {
		const id = 'testUser';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getDepositRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'DEPOSIT#TS#1000000000',
					':endSk': 'DEPOSIT#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#testUser', sk: 'DEPOSIT#TS#1500000000' };
			await getDepositRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'DEPOSIT#TS#1000000000',
					':endSk': 'DEPOSIT#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#testUser', sk: 'DEPOSIT#TS#1500000000', amount: 100 },
				{ pk: 'USER#testUser', sk: 'DEPOSIT#TS#1600000000', amount: 200 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#testUser', sk: 'DEPOSIT#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getDepositRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getDepositRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
