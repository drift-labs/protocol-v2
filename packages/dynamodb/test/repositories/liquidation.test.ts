import { IngestionSource, LiquidationRecord } from '@backend/common';
import { LiquidationRepository } from '../../src/repositories/liquidation';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('LiquidationRepository', () => {
	const {
		createLiquidationRecords,
		getLiquidationRecords,
		getLiquidationRecordsBetweenTimestamps,
	} = LiquidationRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createLiquidationRecords', () => {
		it('should call batchWrite with correct parameters for regular liquidations', async () => {
			const records: Partial<LiquidationRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSig: '123',
					slot: 123,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					bankrupt: false,
				},
				{
					user: 'user2',
					ts: 1234567891,
					txSig: '123',
					slot: 124,
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
					bankrupt: false,
				},
			];

			await createLiquidationRecords(records as LiquidationRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'LIQUIDATION#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						GSI1PK: 'LIQUIDATION',
						GSI1SK: 'LIQUIDATION#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						user: 'user1',
						ts: 1234567890,
						txSig: '123',
						slot: 123,
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						bankrupt: false,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'USER#user2',
						sk: 'LIQUIDATION#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						GSI1PK: 'LIQUIDATION',
						GSI1SK: 'LIQUIDATION#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						ts: 1234567891,
						txSig: '123',
						slot: 124,
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
						bankrupt: false,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
				],
			});
		});

		it('should call batchWrite with correct parameters for bankruptcy records', async () => {
			const records: Partial<LiquidationRecord>[] = [
				{
					user: 'user3',
					ts: 1234567892,
					txSig: '456',
					slot: 125,
					txSigIndex: 3,
					source: IngestionSource.SEQUENTIAL,
					bankrupt: true,
				},
			];

			await createLiquidationRecords(records as LiquidationRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user3',
						sk: 'LIQUIDATION#TS#1234567892#SLOT#125#SIG#456#INDEX#00003',
						GSI1PK: 'BANKRUPTCY',
						GSI1SK: 'BANKRUPTCY#TS#1234567892#SLOT#125#SIG#456#INDEX#00003',
						user: 'user3',
						ts: 1234567892,
						txSig: '456',
						slot: 125,
						txSigIndex: 3,
						source: IngestionSource.SEQUENTIAL,
						bankrupt: true,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<LiquidationRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			const result = await createLiquidationRecords(records as LiquidationRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getLiquidationRecords', () => {
		it('should call query with correct parameters when fetching by user ID', async () => {
			const id = 'user1';
			await getLiquidationRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'LIQUIDATION',
				lastEvaluatedKey: null,
			});
		});

		it('should query using GSI1 when fetching liquidation records without a specific user ID', async () => {
			await getLiquidationRecords({});

			expect(mockQuery).toHaveBeenCalledWith({
				secondaryIndex: 'GSI1',
				pk: 'LIQUIDATION',
				sk: 'LIQUIDATION',
				lastEvaluatedKey: null,
			});
		});

		it('should query using GSI1 when fetching bankruptcy records without a specific user ID', async () => {
			await getLiquidationRecords({ bankruptcy: true });

			expect(mockQuery).toHaveBeenCalledWith({
				secondaryIndex: 'GSI1',
				pk: 'BANKRUPTCY',
				sk: 'BANKRUPTCY',
				lastEvaluatedKey: null,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', ts: 1234567890, txSigIndex: 1, liquidationId: 'liq1' },
				{ user: 'user1', ts: 1234567891, txSigIndex: 2, liquidationId: 'liq1' },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'LIQUIDATION#TS#1234567891' };
			mockQuery.mockResolvedValueOnce({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getLiquidationRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'LIQUIDATION#TS#1500000000' };
			await getLiquidationRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'LIQUIDATION',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getLiquidationRecords({ id: 'user1' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});

		it('should fetch up to maxUniqueRecords unique liquidation IDs', async () => {
			const mockItems1 = [
				{ user: 'user1', liquidationId: 'liq1', ts: 1000 },
				{ user: 'user2', liquidationId: 'liq2', ts: 2000 },
				{ user: 'user3', liquidationId: 'liq3', ts: 3000 },
			];
			mockQuery.mockResolvedValueOnce({
				Items: mockItems1,
				LastEvaluatedKey: { pk: 'LIQUIDATION', sk: 'LIQUIDATION#TS#3000' },
			});

			const mockItems2 = [{ user: 'user4', liquidationId: 'liq4', ts: 4000 }];
			mockQuery.mockResolvedValueOnce({
				Items: mockItems2,
				LastEvaluatedKey: null,
			});

			const result = await getLiquidationRecords({ maxUniqueRecords: 3 });

			expect(result.records.length).toBe(3);
			expect(result.records).toEqual(mockItems1);

			expect(mockQuery).toHaveBeenCalledTimes(2);
		});

		it('should fetch bankruptcy records with unique IDs', async () => {
			const mockItems = [
				{ user: 'user1', liquidationId: 'bank1', ts: 1000, bankrupt: true },
				{ user: 'user2', liquidationId: 'bank2', ts: 2000, bankrupt: true },
			];
			mockQuery.mockResolvedValueOnce({
				Items: mockItems,
				LastEvaluatedKey: null,
			});

			const result = await getLiquidationRecords({ bankruptcy: true });

			expect(result.records).toEqual(mockItems);
			expect(mockQuery).toHaveBeenCalledWith({
				secondaryIndex: 'GSI1',
				pk: 'BANKRUPTCY',
				sk: 'BANKRUPTCY',
				lastEvaluatedKey: null,
			});
		});
	});

	describe('getLiquidationRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getLiquidationRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'LIQUIDATION#TS#1000000000',
					':endSk': 'LIQUIDATION#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#user1', sk: 'LIQUIDATION#TS#1500000000' };
			await getLiquidationRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'LIQUIDATION#TS#1000000000',
					':endSk': 'LIQUIDATION#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#user1', sk: 'LIQUIDATION#TS#1500000000', txSigIndex: 1 },
				{ pk: 'USER#user1', sk: 'LIQUIDATION#TS#1600000000', txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'LIQUIDATION#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getLiquidationRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getLiquidationRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
