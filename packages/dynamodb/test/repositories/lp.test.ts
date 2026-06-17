import { IngestionSource, LPRecord } from '@backend/common';
import { LPRepository } from '../../src/repositories/lp';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('LPRepository', () => {
	const { createLPRecords, getLPRecords, getLPRecordsBetweenTimestamps } = LPRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createLPRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<LPRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					slot: 123,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
				{
					user: 'user2',
					ts: 1234567891,
					slot: 124,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			await createLPRecords(records as LPRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'LP#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						user: 'user1',
						slot: 123,
						ts: 1234567890,
						txSig: '123',
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'USER#user2',
						sk: 'LP#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						slot: 124,
						ts: 1234567891,
						txSig: '123',
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<LPRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			const result = await createLPRecords(records as LPRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getLPRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			await getLPRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'LP',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', ts: 1234567890, txSigIndex: 1 },
				{ user: 'user1', ts: 1234567891, txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'LP#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getLPRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'LP#TS#1500000000' };
			await getLPRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'LP',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getLPRecords({ id: 'user1' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getLPRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getLPRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'LP#TS#1000000000',
					':endSk': 'LP#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#user1', sk: 'LP#TS#1500000000' };
			await getLPRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'LP#TS#1000000000',
					':endSk': 'LP#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#user1', sk: 'LP#TS#1500000000', txSigIndex: 1 },
				{ pk: 'USER#user1', sk: 'LP#TS#1600000000', txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'LP#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getLPRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getLPRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
