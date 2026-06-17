import {
	EarnSnapshotRecord,
	EntityTypes,
	RecordTypes,
	SnapshotFrequency,
	SnapshotRecordTypes,
} from '@backend/common';
import { SnapshotRepository } from '../../src/repositories/snapshots';

const mockBatchGet = jest.fn();
const mockQuery = jest.fn();
const mockQueryAll = jest.fn();
const mockBatchWrite = jest.fn();
const mockGet = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchGet: mockBatchGet,
		query: mockQuery,
		queryAll: mockQueryAll,
		batchWrite: mockBatchWrite,
		get: mockGet,
	}),
}));

describe('SnapshotRepository', () => {
	const {
		createSnapshotRecords,
		getSnapshot,
		getPreviousSnapshot,
		getSnapshotsBetweenTimestamps,
		getSnapshotsForTimestamps,
	} = SnapshotRepository();

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.SNAPSHOT_TABLE = 'test-snapshots-table';
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('createSnapshotRecords', () => {
		it('should create daily snapshot records correctly', async () => {
			const mockRecords = [
				{ authority: 'auth1', user: 'user1', ts: 123456789, isDaily: true },
				{ authority: 'auth1', user: 'user2', ts: 123456790, isDaily: true },
			] as unknown as EarnSnapshotRecord[];

			mockBatchWrite.mockResolvedValue({ UnprocessedItems: [] });

			await createSnapshotRecords(mockRecords, RecordTypes.EarnSnapshotRecord);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						GSI1PK: 'AUTHORITY#auth1',
						GSI1SK: 'EARN_SNAPSHOT#123456789',
						createdAt: expect.any(Number),
						authority: 'auth1',
						user: 'user1',
						pk: 'USER#user1',
						sk: 'EARN_SNAPSHOT#123456789',
						ts: 123456789,
						isDaily: true,
					},
					{
						GSI1PK: 'AUTHORITY#auth1',
						GSI1SK: 'EARN_SNAPSHOT#123456790',
						createdAt: expect.any(Number),
						authority: 'auth1',
						user: 'user2',
						pk: 'USER#user2',
						sk: 'EARN_SNAPSHOT#123456790',
						ts: 123456790,
						isDaily: true,
					},
				],
			});
		});

		it('should create hourly snapshot records correctly', async () => {
			const mockRecords = [
				{ authority: 'auth1', user: 'user1', ts: 123456789, isDaily: false },
				{ authority: 'auth1', user: 'user2', ts: 123456790, isDaily: false },
			] as unknown as EarnSnapshotRecord[];

			mockBatchWrite.mockResolvedValue({ UnprocessedItems: [] });

			await createSnapshotRecords(mockRecords, RecordTypes.EarnSnapshotRecord);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						GSI1PK: 'AUTHORITY#auth1',
						GSI1SK: 'HOURLY_EARN_SNAPSHOT#123456789',
						createdAt: expect.any(Number),
						authority: 'auth1',
						user: 'user1',
						pk: 'USER#user1',
						sk: 'HOURLY_EARN_SNAPSHOT#123456789',
						ts: 123456789,
						isDaily: false,
					},
					{
						GSI1PK: 'AUTHORITY#auth1',
						GSI1SK: 'HOURLY_EARN_SNAPSHOT#123456790',
						createdAt: expect.any(Number),
						authority: 'auth1',
						user: 'user2',
						pk: 'USER#user2',
						sk: 'HOURLY_EARN_SNAPSHOT#123456790',
						ts: 123456790,
						isDaily: false,
					},
				],
			});
		});
	});

	describe('getSnapshotsForTimestamps', () => {
		it('should return empty array when no timestamps provided', async () => {
			const params = {
				entity: EntityTypes.User,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				id: 'user1',
				timestamps: [],
				frequency: 'daily' as SnapshotFrequency,
			};

			const result = await getSnapshotsForTimestamps(params);

			expect(result).toEqual([]);
			expect(mockBatchGet).not.toHaveBeenCalled();
		});

		it('should fetch daily trading snapshots for user entity', async () => {
			const params = {
				entity: EntityTypes.User,
				recordType: 'TradeSnapshotRecord' as SnapshotRecordTypes,
				id: 'user1',
				timestamps: [1709164800, 1709208000],
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, id: 'user1' },
				{ ts: 1709208000, id: 'user1' },
			];

			mockBatchGet.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsForTimestamps(params);

			expect(mockBatchGet).toHaveBeenCalledWith({
				keys: [
					{ pk: 'USER#user1', sk: 'TRADE_SNAPSHOT#1709164800' },
					{ pk: 'USER#user1', sk: 'TRADE_SNAPSHOT#1709208000' },
				],
			});
			expect(result).toEqual(mockSnapshots);
		});

		it('should fetch hourly snapshots for authority entity', async () => {
			const params = {
				entity: EntityTypes.Authority,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				id: 'auth1',
				timestamps: [1709164800, 1709208000],
				frequency: 'hourly' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, amount: 100, id: 'auth1' },
				{ ts: 1709208000, amount: 150, id: 'auth1' },
			];

			mockBatchGet.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsForTimestamps(params);

			expect(mockBatchGet).toHaveBeenCalledWith({
				keys: [
					{ pk: 'AUTHORITY#auth1', sk: 'HOURLY_VAULT_SNAPSHOT#1709164800' },
					{ pk: 'AUTHORITY#auth1', sk: 'HOURLY_VAULT_SNAPSHOT#1709208000' },
				],
			});
			expect(result).toEqual(mockSnapshots);
		});

		it('should sort the snapshots by timestamp', async () => {
			const params = {
				entity: EntityTypes.User,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				id: 'user1',
				timestamps: [1709208000, 1709164800],
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709208000, amount: 150, id: 'user1' },
				{ ts: 1709164800, amount: 100, id: 'user1' },
			];

			mockBatchGet.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsForTimestamps(params);

			// Should be sorted by ts in ascending order
			expect(result).toEqual([
				{ ts: 1709164800, amount: 100, id: 'user1' },
				{ ts: 1709208000, amount: 150, id: 'user1' },
			]);
		});
	});

	describe('getSnapshotsBetweenTimestamps', () => {
		it('should fetch daily trading snapshots between timestamps for user entity', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				startTs: 1709164800,
				endTs: 1709208000,
				recordType: 'TradeSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, id: 'user1' },
				{ ts: 1709186400, id: 'user1' },
				{ ts: 1709208000, id: 'user1' },
			];

			mockQueryAll.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsBetweenTimestamps(params);

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':start': 'TRADE_SNAPSHOT#1709164800',
					':end': 'TRADE_SNAPSHOT#1709208000',
				},
			});
			expect(result).toEqual(mockSnapshots);
		});

		it('should fetch hourly trading snapshots between timestamps for user entity', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				startTs: 1709164800,
				endTs: 1709208000,
				recordType: 'TradeSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'hourly' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, id: 'user1' },
				{ ts: 1709186400, id: 'user1' },
				{ ts: 1709208000, id: 'user1' },
			];

			mockQueryAll.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsBetweenTimestamps(params);

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':start': 'HOURLY_TRADE_SNAPSHOT#1709164800',
					':end': 'HOURLY_TRADE_SNAPSHOT#1709208000',
				},
			});
			expect(result).toEqual(mockSnapshots);
		});

		it('should fetch daily snapshots between timestamps for authority entity', async () => {
			const params = {
				entity: EntityTypes.Authority,
				id: 'auth1',
				startTs: 1709164800,
				endTs: 1709208000,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, amount: 100, id: 'auth1' },
				{ ts: 1709186400, amount: 125, id: 'auth1' },
				{ ts: 1709208000, amount: 150, id: 'auth1' },
			];

			mockQueryAll.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsBetweenTimestamps(params);

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
				secondaryIndex: 'GSI1',
				expressionValues: {
					':start': 'VAULT_SNAPSHOT#1709164800',
					':end': 'VAULT_SNAPSHOT#1709208000',
				},
			});
			expect(result).toEqual(mockSnapshots);
		});

		it('should fetch hourly snapshots between timestamps for authority entity', async () => {
			const params = {
				entity: EntityTypes.Authority,
				id: 'auth1',
				startTs: 1709164800,
				endTs: 1709208000,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'hourly' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, amount: 100, id: 'auth1' },
				{ ts: 1709186400, amount: 125, id: 'auth1' },
				{ ts: 1709208000, amount: 150, id: 'auth1' },
			];

			mockQueryAll.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsBetweenTimestamps(params);

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
				secondaryIndex: 'GSI1',
				expressionValues: {
					':start': 'HOURLY_VAULT_SNAPSHOT#1709164800',
					':end': 'HOURLY_VAULT_SNAPSHOT#1709208000',
				},
			});
			expect(result).toEqual(mockSnapshots);
		});

		it('should fetch referral snapshots between timestamps for authority entity using primary keys', async () => {
			const params = {
				entity: EntityTypes.Authority,
				id: 'auth1',
				startTs: 1709164800,
				endTs: 1709208000,
				recordType: RecordTypes.ReferralSnapshotRecord as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshots = [
				{ ts: 1709164800, id: 'auth1' },
				{ ts: 1709186400, id: 'auth1' },
				{ ts: 1709208000, id: 'auth1' },
			];

			mockQueryAll.mockResolvedValue(mockSnapshots);

			const result = await getSnapshotsBetweenTimestamps(params);

			expect(mockQueryAll).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':start': 'REFERRAL_SNAPSHOT#1709164800',
					':end': 'REFERRAL_SNAPSHOT#1709208000',
				},
			});
			expect(result).toEqual(mockSnapshots);
		});
	});

	describe('getSnapshot', () => {
		it('should fetch the earliest hourly vault snapshot for user when orderAsc is true', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				orderAsc: true,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'hourly' as SnapshotFrequency,
			};

			const mockSnapshot = { ts: 1709164800, amount: 100, id: 'user1' };

			mockQuery.mockResolvedValue({
				Items: [mockSnapshot],
			});

			const result = await getSnapshot(params);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				sk: 'HOURLY_VAULT_SNAPSHOT',
				orderAsc: true,
				limit: 1,
			});
			expect(result).toEqual(mockSnapshot);
		});

		it('should fetch the latest daily earn snapshot for authority', async () => {
			const params = {
				entity: EntityTypes.Authority,
				id: 'auth1',
				orderAsc: false,
				recordType: 'EarnSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshot = { ts: 1709208000, id: 'auth1' };

			mockQuery.mockResolvedValue({
				Items: [mockSnapshot],
			});

			const result = await getSnapshot(params);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				sk: 'EARN_SNAPSHOT',
				orderAsc: false,
				limit: 1,
			});
			expect(result).toEqual(mockSnapshot);
		});

		it('should fetch the latest hourly earn snapshot for authority', async () => {
			const params = {
				entity: EntityTypes.Authority,
				id: 'auth1',
				orderAsc: false,
				recordType: 'EarnSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'hourly' as SnapshotFrequency,
			};

			const mockSnapshot = { ts: 1709208000, id: 'auth1' };

			mockQuery.mockResolvedValue({
				Items: [mockSnapshot],
			});

			const result = await getSnapshot(params);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#auth1',
				sk: 'HOURLY_EARN_SNAPSHOT',
				orderAsc: false,
				limit: 1,
			});
			expect(result).toEqual(mockSnapshot);
		});

		it('should return undefined when no snapshot exists', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				orderAsc: false,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			mockQuery.mockResolvedValue({
				Items: [],
			});

			const result = await getSnapshot(params);

			expect(result).toBeUndefined();
		});
	});

	describe('getPreviousSnapshot', () => {
		it('should fetch the previous daily vault snapshot for user', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				timestamp: 1709208000,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshot = { ts: 1709164800, amount: 100, id: 'user1' };

			mockQuery.mockResolvedValue({
				Items: [mockSnapshot],
			});

			const result = await getPreviousSnapshot(params);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':end': 'VAULT_SNAPSHOT#1709208000',
					':start': 'VAULT_SNAPSHOT#0',
				},
				limit: 1,
			});
			expect(result).toEqual(mockSnapshot);
		});

		it('should fetch the previous hourly vault snapshot for user', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				timestamp: 1709208000,
				recordType: 'VaultDepositorSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'hourly' as SnapshotFrequency,
			};

			const mockSnapshot = { ts: 1709164800, amount: 100, id: 'user1' };

			mockQuery.mockResolvedValue({
				Items: [mockSnapshot],
			});

			const result = await getPreviousSnapshot(params);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':end': 'HOURLY_VAULT_SNAPSHOT#1709208000',
					':start': 'HOURLY_VAULT_SNAPSHOT#0',
				},
				limit: 1,
			});
			expect(result).toEqual(mockSnapshot);
		});

		it('should fetch the previous daily trading snapshot for user', async () => {
			const params = {
				entity: EntityTypes.User,
				id: 'user1',
				timestamp: 1709208000,
				recordType: 'TradeSnapshotRecord' as SnapshotRecordTypes,
				frequency: 'daily' as SnapshotFrequency,
			};

			const mockSnapshot = { ts: 1709164800, id: 'user1' };

			mockQuery.mockResolvedValue({
				Items: [mockSnapshot],
			});

			const result = await getPreviousSnapshot(params);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#user1',
				expression: 'pk = :pk AND sk BETWEEN :start AND :end',
				expressionValues: {
					':end': 'TRADE_SNAPSHOT#1709208000',
					':start': 'TRADE_SNAPSHOT#0',
				},
				limit: 1,
			});
			expect(result).toEqual(mockSnapshot);
		});
	});
});
