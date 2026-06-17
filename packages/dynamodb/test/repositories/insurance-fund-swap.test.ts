import { IngestionSource, InsuranceFundSwapRecord } from '@backend/common';
import { InsuranceFundSwapRepository } from '../../src/repositories/insurance-fund-swap';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
	}),
}));

describe('InsuranceFundSwapRepository', () => {
	const {
		createInsuranceFundSwapRecords,
		getInsuranceFundSwapRecords,
		getInsuranceFundSwapRecordsBetweenTimestamps,
	} = InsuranceFundSwapRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createInsuranceFundSwapRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: Partial<InsuranceFundSwapRecord>[] = [
				{
					ts: 1234567890,
					txSig: 'sig1',
					txSigIndex: 1,
					slot: 100,
					inMarketIndex: 0,
					outMarketIndex: 1,
					inAmount: 1000,
					outAmount: 2000,
					inVaultAmountBefore: 10000,
					outVaultAmountBefore: 20000,
					inFundVaultAmountAfter: 11000,
					outFundVaultAmountAfter: 18000,
					inIfTotalSharesBefore: 5000,
					outIfTotalSharesBefore: 6000,
					inIfTotalSharesAfter: 5500,
					outIfTotalSharesAfter: 5500,
					inIfUserSharesBefore: 1000,
					outIfUserSharesBefore: 1200,
					inIfUserSharesAfter: 1100,
					outIfUserSharesAfter: 1100,
					outOraclePrice: 1.5,
					outOraclePriceTwap: 1.48,
					rebalanceConfig: 'config1',
					source: IngestionSource.SEQUENTIAL,
				},
			];

			await createInsuranceFundSwapRecords(records as InsuranceFundSwapRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: expect.arrayContaining([
					expect.objectContaining({
						...records[0],
					}),
				]),
			});
		});
	});

	describe('getInsuranceFundSwapRecords', () => {
		it('should return empty array when no records exist', async () => {
			const result = await getInsuranceFundSwapRecords({});
			expect(result.records).toEqual([]);
			expect(result.meta.nextPage).toBeNull();
		});

		it('should return records and pagination info', async () => {
			const mockRecords = [
				{
					ts: 1234567890,
					txSig: 'sig1',
				},
			];
			mockQuery.mockResolvedValueOnce({
				Items: mockRecords,
				LastEvaluatedKey: { pk: 'lastKey' },
			});

			const result = await getInsuranceFundSwapRecords({});
			expect(result.records).toEqual(mockRecords);
			expect(result.meta.nextPage).toEqual({ pk: 'lastKey' });
		});
	});

	describe('getInsuranceFundSwapRecordsBetweenTimestamps', () => {
		it('should query with correct parameters', async () => {
			const startTs = 1000;
			const endTs = 2000;

			await getInsuranceFundSwapRecordsBetweenTimestamps({
				startTs,
				endTs,
			});

			expect(mockQuery).toHaveBeenCalledWith(
				expect.objectContaining({
					expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
					expressionValues: expect.objectContaining({
						':startSk': expect.stringContaining(startTs.toString()),
						':endSk': expect.stringContaining(endTs.toString()),
					}),
				})
			);
		});

		it('should handle pagination', async () => {
			const mockPage = { pk: 'lastKey' };
			await getInsuranceFundSwapRecordsBetweenTimestamps({
				startTs: 1000,
				endTs: 2000,
				page: mockPage,
			});

			expect(mockQuery).toHaveBeenCalledWith(
				expect.objectContaining({
					lastEvaluatedKey: mockPage,
				})
			);
		});
	});
});
