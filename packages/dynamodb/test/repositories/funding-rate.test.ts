import { FundingRateRecord, IngestionSource } from '@backend/common';
import { FundingRateRepository } from '../../src/repositories/funding-rate';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('FundingRateRepository', () => {
	const {
		createFundingRateRecords,
		getFundingRateRecords,
		getFundingRateRecordsBetweenTimestamps,
	} = FundingRateRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createFundingRateRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<FundingRateRecord>[] = [
				{
					symbol: 'BTC',
					ts: 1234567890,
					slot: 123,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
				{
					symbol: 'ETH',
					ts: 1234567891,
					slot: 124,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			await createFundingRateRecords(records as FundingRateRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'MARKET#BTC',
						sk: 'FUNDING_RATE#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
						symbol: 'BTC',
						slot: 123,
						ts: 1234567890,
						txSigIndex: 1,
						source: IngestionSource.SEQUENTIAL,
						txSig: '123',
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
					{
						pk: 'MARKET#ETH',
						sk: 'FUNDING_RATE#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						symbol: 'ETH',
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

			const records: Partial<FundingRateRecord>[] = [
				{
					symbol: 'BTC',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			const result = await createFundingRateRecords(records as FundingRateRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getFundingRateRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'BTC';
			await getFundingRateRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'FUNDING_RATE',
				lastEvaluatedKey: undefined,
				limit: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ symbol: 'BTC', ts: 1234567890, rate: 0.001 },
				{ symbol: 'BTC', ts: 1234567891, rate: 0.002 },
			];
			const mockLastEvaluatedKey = { pk: 'MARKET#BTC', sk: 'FUNDING_RATE#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getFundingRateRecords({ id: 'BTC' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'BTC';
			const page = { pk: 'MARKET#BTC', sk: 'FUNDING_RATE#TS#1500000000' };
			await getFundingRateRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'FUNDING_RATE',
				lastEvaluatedKey: page,
				limit: undefined,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getFundingRateRecords({ id: 'BTC' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getFundingRateRecordsBetweenTimestamps', () => {
		const id = 'BTC';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getFundingRateRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'MARKET#BTC',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'MARKET#BTC',
					':startSk': 'FUNDING_RATE#TS#1000000000',
					':endSk': 'FUNDING_RATE#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
				limit: 20,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'MARKET#BTC', sk: 'FUNDING_RATE#TS#1500000000' };
			await getFundingRateRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'MARKET#BTC',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'MARKET#BTC',
					':startSk': 'FUNDING_RATE#TS#1000000000',
					':endSk': 'FUNDING_RATE#TS#2000000000',
				},
				lastEvaluatedKey: page,
				limit: 20,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'MARKET#BTC', sk: 'FUNDING_RATE#TS#1500000000', rate: 0.001 },
				{ pk: 'MARKET#BTC', sk: 'FUNDING_RATE#TS#1600000000', rate: 0.002 },
			];
			const mockLastEvaluatedKey = { pk: 'MARKET#BTC', sk: 'FUNDING_RATE#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getFundingRateRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getFundingRateRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
