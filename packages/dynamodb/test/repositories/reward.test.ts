import { EntityTypes, IngestionSource, RewardRecord } from '@backend/common';
import { RewardRepository } from '../../src/repositories/reward';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('RewardRepository', () => {
	const { createRewardRecords, getRewardRecords, getRewardRecordsBetweenTimestamps } =
		RewardRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createRewardRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<RewardRecord>[] = [
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

			await createRewardRecords(records as RewardRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'REWARD#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
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
						sk: 'REWARD#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
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
						sk: 'REWARD#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
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

			const records: Partial<RewardRecord>[] = [
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

			const result = await createRewardRecords(records as RewardRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getRewardRecords', () => {
		it('should call query with correct parameters for user entity', async () => {
			const id = 'testUser';
			await getRewardRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'REWARD',
				lastEvaluatedKey: undefined,
			});
		});

		it('should call query with correct parameters for market entity', async () => {
			const id = 'SOL';
			await getRewardRecords({ id, entity: EntityTypes.Market });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'REWARD',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ id: '1', amount: 100, rewardType: 'referral' },
				{ id: '2', amount: 200, rewardType: 'referral' },
			];
			const mockLastEvaluatedKey = { pk: 'USER#testUser', sk: 'REWARD#TS#1234567890' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getRewardRecords({ id: 'testUser' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'testUser';
			const page = { pk: 'USER#testUser', sk: 'REWARD#TS#1500000000' };
			await getRewardRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'REWARD',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getRewardRecords({ id: 'testUser' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getRewardRecordsBetweenTimestamps', () => {
		const id = 'testUser';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters for user entity', async () => {
			await getRewardRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'REWARD#TS#1000000000',
					':endSk': 'REWARD#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should call query with correct parameters for market entity', async () => {
			await getRewardRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
				entity: EntityTypes.Market,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'MARKET#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'REWARD#TS#1000000000',
					':endSk': 'REWARD#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#testUser', sk: 'REWARD#TS#1500000000' };
			await getRewardRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'REWARD#TS#1000000000',
					':endSk': 'REWARD#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{
					pk: 'USER#testUser',
					sk: 'REWARD#TS#1500000000',
					amount: 100,
					rewardType: 'referral',
				},
				{
					pk: 'USER#testUser',
					sk: 'REWARD#TS#1600000000',
					amount: 200,
					rewardType: 'referral',
				},
			];
			const mockLastEvaluatedKey = { pk: 'USER#testUser', sk: 'REWARD#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getRewardRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getRewardRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
