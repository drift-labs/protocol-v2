import { EntityTypes, IngestionSource, SwapRecord } from '@backend/common';
import { SwapRepository } from '../../src/repositories/swap';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('SwapRepository', () => {
	const { createSwapRecords, getSwapRecords, getSwapRecordsBetweenTimestamps } = SwapRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createSwapRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<SwapRecord>[] = [
				{
					user: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Market,
					isInMarket: false,
					inSymbol: 'SOL',
					outSymbol: 'USDC',
				},
			];

			await createSwapRecords(records as SwapRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'SWAP#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						user: 'user1',
						slot: 123,
						ts: 1234567890,
						txSig: '123',
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						entity: EntityTypes.User,
					},
					{
						pk: 'USER#user2',
						sk: 'SWAP#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						slot: 124,
						ts: 1234567891,
						txSig: '123',
						source: IngestionSource.SEQUENTIAL,
						txSigIndex: 2,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						entity: EntityTypes.User,
					},
					{
						inSymbol: 'SOL',
						isInMarket: false,
						outSymbol: 'USDC',
						pk: 'MARKET#USDC',
						sk: 'SWAP#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						slot: 124,
						ts: 1234567891,
						txSig: '123',
						source: IngestionSource.SEQUENTIAL,
						txSigIndex: 2,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						entity: EntityTypes.Market,
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<SwapRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.User,
				},
			];

			const result = await createSwapRecords(records as SwapRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getSwapRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			await getSwapRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'SWAP',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ user: 'user1', ts: 1234567890, txSigIndex: 1 },
				{ user: 'user1', ts: 1234567891, txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'SWAP#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getSwapRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'USER#user1', sk: 'SWAP#TS#1500000000' };
			await getSwapRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'SWAP',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getSwapRecords({ id: 'user1' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getSwapRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getSwapRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'SWAP#TS#1000000000',
					':endSk': 'SWAP#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#user1', sk: 'SWAP#TS#1500000000' };
			await getSwapRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#user1',
					':startSk': 'SWAP#TS#1000000000',
					':endSk': 'SWAP#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#user1', sk: 'SWAP#TS#1500000000', txSigIndex: 1 },
				{ pk: 'USER#user1', sk: 'SWAP#TS#1600000000', txSigIndex: 2 },
			];
			const mockLastEvaluatedKey = { pk: 'USER#user1', sk: 'SWAP#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getSwapRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getSwapRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
