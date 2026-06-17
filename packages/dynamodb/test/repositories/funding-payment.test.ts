import { FundingPaymentRecord, IngestionSource } from '@backend/common';
import { FundingPaymentRepository } from '../../src/repositories/funding-payment';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('FundingPaymentRepository', () => {
	const {
		createFundingPaymentRecords,
		getFundingPaymentRecords,
		getFundingPaymentRecordsBetweenTimestamps,
	} = FundingPaymentRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createFundingPaymentRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<FundingPaymentRecord>[] = [
				{
					user: 'user1',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
				{
					user: 'user2',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			await createFundingPaymentRecords(records as FundingPaymentRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'USER#user1',
						sk: 'FUNDING_PAYMENT#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						user: 'user1',
						slot: 123,
						ts: 1234567890,
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						txSig: '123',
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'USER#user2',
						sk: 'FUNDING_PAYMENT#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						user: 'user2',
						slot: 124,
						ts: 1234567891,
						txSigIndex: 2,
						txSig: '123',
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

			const records: Partial<FundingPaymentRecord>[] = [
				{
					user: 'user1',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			const result = await createFundingPaymentRecords(records as FundingPaymentRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getFundingPaymentRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'testUser';
			await getFundingPaymentRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'FUNDING_PAYMENT',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ id: '1', amount: 100 },
				{ id: '2', amount: 200 },
			];
			const mockLastEvaluatedKey = {
				pk: 'USER#testUser',
				sk: 'FUNDING_PAYMENT#TS#1234567890',
			};
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getFundingPaymentRecords({ id: 'testUser' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'testUser';
			const page = { pk: 'USER#testUser', sk: 'FUNDING_PAYMENT#TS#1500000000' };
			await getFundingPaymentRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `USER#${id}`,
				sk: 'FUNDING_PAYMENT',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getFundingPaymentRecords({ id: 'testUser' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getFundingPaymentRecordsBetweenTimestamps', () => {
		const id = 'testUser';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getFundingPaymentRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'FUNDING_PAYMENT#TS#1000000000',
					':endSk': 'FUNDING_PAYMENT#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'USER#testUser', sk: 'FUNDING_PAYMENT#TS#1500000000' };
			await getFundingPaymentRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'USER#testUser',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'USER#testUser',
					':startSk': 'FUNDING_PAYMENT#TS#1000000000',
					':endSk': 'FUNDING_PAYMENT#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'USER#testUser', sk: 'FUNDING_PAYMENT#TS#1500000000', amount: 100 },
				{ pk: 'USER#testUser', sk: 'FUNDING_PAYMENT#TS#1600000000', amount: 200 },
			];
			const mockLastEvaluatedKey = {
				pk: 'USER#testUser',
				sk: 'FUNDING_PAYMENT#TS#1600000000',
			};
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getFundingPaymentRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getFundingPaymentRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
