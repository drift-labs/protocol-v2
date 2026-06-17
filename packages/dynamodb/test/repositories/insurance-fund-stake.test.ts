import { EntityTypes, IngestionSource, InsuranceFundStakeRecord } from '@backend/common';
import { InsuranceFundStakeRepository } from '../../src/repositories/insurance-fund-stake';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('InsuranceFundStakeRepository', () => {
	const {
		createInsuranceFundStakeRecords,
		getInsuranceFundStakeRecords,
		getInsuranceFundStakeRecordsBetweenTimestamps,
	} = InsuranceFundStakeRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createInsuranceFundStakeRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<InsuranceFundStakeRecord>[] = [
				{
					userAuthority: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Authority,
					symbol: 'SOL',
					amount: 100,
				},
				{
					userAuthority: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Authority,
					symbol: 'USDC',
					amount: 200,
				},
				{
					userAuthority: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Market,
					symbol: 'USDC',
					amount: 200,
				},
			];

			await createInsuranceFundStakeRecords(records as InsuranceFundStakeRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'AUTHORITY#user1',
						sk: 'INSURANCE_FUND_STAKE#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						GSI1PK: 'AUTHORITY#user1',
						GSI1SK: 'INSURANCE_FUND_STAKE#MARKET#SOL#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						userAuthority: 'user1',
						slot: 123,
						ts: 1234567890,
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.Authority,
						symbol: 'SOL',
						txSig: '123',
						amount: 100,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'AUTHORITY#user2',
						sk: 'INSURANCE_FUND_STAKE#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						GSI1PK: 'AUTHORITY#user2',
						GSI1SK: 'INSURANCE_FUND_STAKE#MARKET#USDC#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						userAuthority: 'user2',
						symbol: 'USDC',
						txSig: '123',
						slot: 124,
						ts: 1234567891,
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
						entity: EntityTypes.Authority,
						amount: 200,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						amount: 200,
						entity: 'market',
						pk: 'MARKET#USDC',
						sk: 'INSURANCE_FUND_STAKE#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						slot: 124,
						source: 'seq',
						symbol: 'USDC',
						ts: 1234567891,
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
						txSig: '123',
						txSigIndex: 2,
						userAuthority: 'user2',
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<InsuranceFundStakeRecord>[] = [
				{
					userAuthority: 'user1',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
					entity: EntityTypes.Authority,
					amount: 100,
				},
			];

			const result = await createInsuranceFundStakeRecords(
				records as InsuranceFundStakeRecord[]
			);

			expect(result).toBe(failedItems);
		});
	});

	describe('getInsuranceFundStakeRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'user1';
			await getInsuranceFundStakeRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `AUTHORITY#${id}`,
				sk: 'INSURANCE_FUND_STAKE',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ userAuthority: 'user1', ts: 1234567890, amount: 100 },
				{ userAuthority: 'user1', ts: 1234567891, amount: 200 },
			];
			const mockLastEvaluatedKey = {
				pk: 'AUTHORITY#user1',
				sk: 'INSURANCE_FUND_STAKE#TS#1234567891',
			};
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getInsuranceFundStakeRecords({ id: 'user1' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'user1';
			const page = { pk: 'AUTHORITY#user1', sk: 'INSURANCE_FUND_STAKE#TS#1500000000' };
			await getInsuranceFundStakeRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `AUTHORITY#${id}`,
				sk: 'INSURANCE_FUND_STAKE',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getInsuranceFundStakeRecords({ id: 'user1' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getInsuranceFundStakeRecordsBetweenTimestamps', () => {
		const id = 'user1';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getInsuranceFundStakeRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'AUTHORITY#user1',
					':startSk': 'INSURANCE_FUND_STAKE#TS#1000000000',
					':endSk': 'INSURANCE_FUND_STAKE#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'AUTHORITY#user1', sk: 'INSURANCE_FUND_STAKE#TS#1500000000' };
			await getInsuranceFundStakeRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'AUTHORITY#user1',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'AUTHORITY#user1',
					':startSk': 'INSURANCE_FUND_STAKE#TS#1000000000',
					':endSk': 'INSURANCE_FUND_STAKE#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'AUTHORITY#user1', sk: 'INSURANCE_FUND_STAKE#TS#1500000000', amount: 100 },
				{ pk: 'AUTHORITY#user1', sk: 'INSURANCE_FUND_STAKE#TS#1600000000', amount: 200 },
			];
			const mockLastEvaluatedKey = {
				pk: 'AUTHORITY#user1',
				sk: 'INSURANCE_FUND_STAKE#TS#1600000000',
			};
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getInsuranceFundStakeRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
			});

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

			const result = await getInsuranceFundStakeRecordsBetweenTimestamps({
				id,
				startTs,
				endTs,
			});

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
