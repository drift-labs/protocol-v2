import { IngestionSource, SettlePnlRecord } from '@backend/common';
import { SettlePnlRepository } from '../../src/repositories/settle-pnl';

const mockBatch = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatch,
		query: mockQuery,
	}),
}));

describe('SettlePnlRepository', () => {
	const { createSettlePnlRecords, getSettlePnlRecords, getSettlePnlRecordsBetweenTimestamps } =
		SettlePnlRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createSettlePnlRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: SettlePnlRecord[] = [
				{
					user: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					source: IngestionSource.SEQUENTIAL,
					txSigIndex: 1,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					source: IngestionSource.SEQUENTIAL,
					txSigIndex: 1,
				},
			] as SettlePnlRecord[];

			await createSettlePnlRecords(records);

			expect(mockBatch).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'SETTLE_PNL#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						user: 'user1',
						slot: 123,
						ts: 1234567890,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						txSig: '123',
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
					},
					{
						pk: 'USER#user2',
						sk: 'SETTLE_PNL#TS#1234567891#SLOT#124#SIG#123#INDEX#00001',
						user: 'user2',
						slot: 124,
						ts: 1234567891,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						txSig: '123',
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatch.mockResolvedValue(failedItems);

			const records: SettlePnlRecord[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
			] as SettlePnlRecord[];

			const result = await createSettlePnlRecords(records);

			expect(result).toBe(failedItems);
		});

		it('should handle empty input array', async () => {
			await createSettlePnlRecords([]);

			expect(mockBatch).toHaveBeenCalledWith({ records: [] });
		});
	});

	describe('getSettlePnlRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			await getSettlePnlRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'SETTLE_PNL',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', ts: 1234567890, txSigIndex: 1 },
				{ user: 'user1', ts: 1234567891, txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'SETTLE_PNL#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getSettlePnlRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'SETTLE_PNL#TS#1500000000' };
			await getSettlePnlRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'SETTLE_PNL',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getSettlePnlRecords({ id: 'user1' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getSettlePnlRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getSettlePnlRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'SETTLE_PNL#TS#1000000000',
					':endSk': 'SETTLE_PNL#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#user1', sk: 'SETTLE_PNL#TS#1500000000' };
			await getSettlePnlRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'SETTLE_PNL#TS#1000000000',
					':endSk': 'SETTLE_PNL#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#user1', sk: 'SETTLE_PNL#TS#1500000000', txSigIndex: 1 },
				{ pk: 'USER#user1', sk: 'SETTLE_PNL#TS#1600000000', txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'SETTLE_PNL#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getSettlePnlRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getSettlePnlRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
