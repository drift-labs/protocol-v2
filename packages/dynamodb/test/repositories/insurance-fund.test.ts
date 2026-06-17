import { IngestionSource, InsuranceFundRecord } from '@backend/common';
import { InsuranceFundRepository } from '../../src/repositories/insurance-fund';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('InsuranceFundRepository', () => {
	const {
		createInsuranceFundRecords,
		getInsuranceFundRecords,
		getInsuranceFundRecordsBetweenTimestamps,
	} = InsuranceFundRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createInsuranceFundRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<InsuranceFundRecord>[] = [
				{
					symbol: 'BTC',
					slot: 123,
					ts: 1234567890,
					txSig: '123',
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
				{
					symbol: 'ETH',
					slot: 124,
					ts: 1234567891,
					txSig: '123',
					txSigIndex: 2,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			await createInsuranceFundRecords(records as InsuranceFundRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: 'MARKET#BTC',
						sk: 'INSURANCE_FUND#TS#1234567890#SLOT#123#SIG#123#INDEX#00001',
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
						sk: 'INSURANCE_FUND#TS#1234567891#SLOT#124#SIG#123#INDEX#00002',
						symbol: 'ETH',
						slot: 124,
						ts: 1234567891,
						txSigIndex: 2,
						source: IngestionSource.SEQUENTIAL,
						txSig: '123',
						createdAt: expect.any(Number),
						ttl: expect.any(Number),
					},
				],
			});
		});

		it('should return the result of batchWrite', async () => {
			const failedItems = [{ id: '1', data: 'test1' }];
			mockBatchWrite.mockResolvedValue(failedItems);

			const records: Partial<InsuranceFundRecord>[] = [
				{
					symbol: 'BTC',
					ts: 1234567890,
					txSigIndex: 1,
					source: IngestionSource.SEQUENTIAL,
				},
			];

			const result = await createInsuranceFundRecords(records as InsuranceFundRecord[]);

			expect(result).toBe(failedItems);
		});
	});

	describe('getInsuranceFundRecords', () => {
		it('should call query with correct parameters', async () => {
			const id = 'BTC';
			await getInsuranceFundRecords({ id });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'INSURANCE_FUND#',
				lastEvaluatedKey: undefined,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ symbol: 'BTC', ts: 1234567890, balance: 1000000 },
				{ symbol: 'BTC', ts: 1234567891, balance: 1100000 },
			];
			const mockLastEvaluatedKey = { pk: 'MARKET#BTC', sk: 'INSURANCE_FUND#TS#1234567891' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getInsuranceFundRecords({ id: 'BTC' });

			expect(result).toEqual({
				records: mockItems,
				meta: { nextPage: mockLastEvaluatedKey },
			});
		});

		it('should handle pagination', async () => {
			const id = 'BTC';
			const page = { pk: 'MARKET#BTC', sk: 'INSURANCE_FUND#TS#1500000000' };
			await getInsuranceFundRecords({ id, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `MARKET#${id}`,
				sk: 'INSURANCE_FUND#',
				lastEvaluatedKey: page,
			});
		});

		it('should return empty records and null nextPage when no items', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getInsuranceFundRecords({ id: 'BTC' });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});

	describe('getInsuranceFundRecordsBetweenTimestamps', () => {
		const id = 'BTC';
		const startTs = 1000000000;
		const endTs = 2000000000;

		it('should call query with correct parameters', async () => {
			await getInsuranceFundRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'MARKET#BTC',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'MARKET#BTC',
					':startSk': 'INSURANCE_FUND#TS#1000000000',
					':endSk': 'INSURANCE_FUND#TS#2000000000',
				},
				lastEvaluatedKey: undefined,
			});
		});

		it('should handle pagination', async () => {
			const page = { pk: 'MARKET#BTC', sk: 'INSURANCE_FUND#TS#1500000000' };
			await getInsuranceFundRecordsBetweenTimestamps({ id, startTs, endTs, page });

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'MARKET#BTC',
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': 'MARKET#BTC',
					':startSk': 'INSURANCE_FUND#TS#1000000000',
					':endSk': 'INSURANCE_FUND#TS#2000000000',
				},
				lastEvaluatedKey: page,
			});
		});

		it('should return records and metadata', async () => {
			const mockItems = [
				{ pk: 'MARKET#BTC', sk: 'INSURANCE_FUND#TS#1500000000', balance: 1000000 },
				{ pk: 'MARKET#BTC', sk: 'INSURANCE_FUND#TS#1600000000', balance: 1100000 },
			];
			const mockLastEvaluatedKey = { pk: 'MARKET#BTC', sk: 'INSURANCE_FUND#TS#1600000000' };
			mockQuery.mockResolvedValue({
				Items: mockItems,
				LastEvaluatedKey: mockLastEvaluatedKey,
			});

			const result = await getInsuranceFundRecordsBetweenTimestamps({ id, startTs, endTs });

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

			const result = await getInsuranceFundRecordsBetweenTimestamps({ id, startTs, endTs });

			expect(result).toEqual({
				records: [],
				meta: { nextPage: null },
			});
		});
	});
});
