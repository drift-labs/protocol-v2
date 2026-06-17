import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { CandleRecord, CandleResolutions, IngestionSource, TradeRecord } from '@backend/common';
import { CANDLE_PK } from '../../src';
import { CandleRepository } from '../../src/repositories/candles';

const mockBatchWrite = jest.fn();
const mockQuery = jest.fn();
const mockUpdate = jest.fn();
const mockGet = jest.fn();

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		batchWrite: mockBatchWrite,
		query: mockQuery,
		update: mockUpdate,
		get: mockGet,
	}),
}));

describe('CandleRepository', () => {
	const {
		getLatestCandle,
		getCandle,
		getCandlesForResolution,
		getCandlesBetweenTimestampsForResolution,
		createCandleRecords,
		updateCandleRecord,
	} = CandleRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('createCandleRecords', () => {
		it('should call batchWrite with correct parameters', async () => {
			const records: CandleRecord[] = [
				{
					symbol: 'SOL-PERP',
					resolution: '1',
					ts: 1234567890,
					fillOpen: 100,
					fillHigh: 100,
					fillLow: 100,
					fillClose: 100,
					oracleOpen: 100,
					oracleHigh: 100,
					oracleLow: 100,
					oracleClose: 100,
					baseVolume: 0,
					quoteVolume: 0,
					lastTradeTs: 1234567890,
					lastFillRecordId: '987654321',
				},
			];

			await createCandleRecords(records as CandleRecord[]);

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					{
						pk: `${CANDLE_PK}#SOL-PERP#1`,
						sk: '1234567890',
						...records[0],
						createdAt: expect.any(Number),
					},
				],
			});
		});
	});

	describe('updateCandleRecord', () => {
		const mockTrade = {
			symbol: 'SOL-PERP',
			price: 100,
			oraclePrice: 100,
			baseAssetAmountFilled: 1,
			quoteAssetAmountFilled: 100,
			ts: 1234567890,
			source: IngestionSource.SEQUENTIAL,
			fillRecordId: '987654321',
		} as TradeRecord & { price: number; oraclePrice: number };

		it('should handle updateOpenOnly', async () => {
			mockUpdate.mockResolvedValueOnce({ Attributes: {} });

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1234567890,
				updateOpenOnly: true,
			});

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET fillOpen = :price, oracleOpen = :oraclePrice',
				expressionValues: {
					':price': 100,
					':oraclePrice': 100,
				},
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});
		});

		it('should handle updateEmptyCandle', async () => {
			mockUpdate.mockResolvedValueOnce({ Attributes: {} });

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1234567890,
				updateEmptyCandle: true,
			});

			expect(mockUpdate).toHaveBeenCalledWith({
				expressionValues: {
					':oraclePrice': 100,
					':price': 100,
				},
				pk: 'CANDLE#SOL-PERP#1',
				sk: '1234567890',
				updateExpression: `SET fillOpen = :price, fillHigh = :price, fillLow = :price, fillClose = :price, oracleOpen = :oraclePrice, oracleHigh = :oraclePrice, oracleLow = :oraclePrice, oracleClose = :oraclePrice`,
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});
		});

		it('should update high/low prices when necessary', async () => {
			mockUpdate.mockResolvedValueOnce({
				Attributes: {
					fillHigh: 90,
					fillLow: 110,
					oracleHigh: 90,
					oracleLow: 110,
					lastTradeTs: 1234567880,
					lastFillRecordId: 987654320,
				},
			});

			mockUpdate.mockResolvedValueOnce({
				Attributes: {
					fillHigh: 100,
					fillLow: 100,
					oracleHigh: 100,
					oracleLow: 100,
					lastTradeTs: 1234567890,
					lastFillRecordId: '987654321',
				},
			});

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1234567890,
			});

			expect(mockUpdate).toHaveBeenCalledTimes(2);

			expect(mockUpdate).toHaveBeenCalledWith({
				expressionValues: {
					':baseVolume': 1,
					':oraclePrice': 100,
					':price': 100,
					':quoteVolume': 100,
				},
				pk: 'CANDLE#SOL-PERP#1',
				sk: '1234567890',
				updateExpression:
					'SET fillOpen = if_not_exists(fillOpen, :price), oracleOpen = if_not_exists(oracleOpen, :oraclePrice) ADD quoteVolume :quoteVolume, baseVolume :baseVolume',
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});

			expect(mockUpdate).toHaveBeenCalledWith({
				expressionValues: {
					':newFillHigh': 100,
					':newFillLow': 100,
					':newLastTradeTs': 1234567890,
					':newLastFillRecordId': '987654321',
					':newOracleHigh': 100,
					':newOracleLow': 100,
					':newFillClose': 100,
					':newOracleClose': 100,
				},
				pk: 'CANDLE#SOL-PERP#1',
				sk: '1234567890',
				updateExpression:
					'SET fillHigh = :newFillHigh, fillLow = :newFillLow, oracleHigh = :newOracleHigh, oracleLow = :newOracleLow, fillClose = :newFillClose, oracleClose = :newOracleClose, lastTradeTs = :newLastTradeTs, lastFillRecordId = :newLastFillRecordId',
			});
		});

		it('should not update close price when fillRecordId is older', async () => {
			mockUpdate.mockResolvedValueOnce({
				Attributes: {
					fillHigh: 110,
					fillLow: 90,
					oracleHigh: 110,
					oracleLow: 90,
					lastTradeTs: 1234567880,
					lastFillRecordId: 999999999,
				},
			});

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1234567890,
			});

			expect(mockUpdate).toHaveBeenCalledTimes(1);

			expect(mockUpdate).toHaveBeenCalledWith({
				expressionValues: {
					':baseVolume': 1,
					':oraclePrice': 100,
					':price': 100,
					':quoteVolume': 100,
				},
				pk: 'CANDLE#SOL-PERP#1',
				sk: '1234567890',
				updateExpression:
					'SET fillOpen = if_not_exists(fillOpen, :price), oracleOpen = if_not_exists(oracleOpen, :oraclePrice) ADD quoteVolume :quoteVolume, baseVolume :baseVolume',
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});
		});

		it('should create a new candle when the conditional check fails', async () => {
			mockUpdate.mockRejectedValueOnce(
				new ConditionalCheckFailedException({
					$metadata: {},
					message: 'The conditional request failed',
				})
			);

			const mockPrevCandle = {
				fillClose: 95,
				oracleClose: 95.5,
			};
			mockQuery.mockResolvedValueOnce({ Items: [mockPrevCandle] });

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1234567890,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				expression: 'pk = :pk',
				expressionValues: {
					':pk': `${CANDLE_PK}#SOL-PERP#1`,
				},
				limit: 1,
			});

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					expect.objectContaining({
						pk: `${CANDLE_PK}#SOL-PERP#1`,
						sk: '1234567890',
						symbol: 'SOL-PERP',
						resolution: '1',
						ts: 1234567890,
						fillOpen: 95,
						oracleOpen: 95.5,
						fillClose: 100,
						oracleClose: 100,
						quoteVolume: 100,
						baseVolume: 1,
						lastTradeTs: 1234567890,
						lastFillRecordId: '987654321',
					}),
				],
			});
		});

		it('should create a new candle with trade price as open when no previous candle exists', async () => {
			mockUpdate.mockRejectedValueOnce(
				new ConditionalCheckFailedException({
					$metadata: {},
					message: 'The conditional request failed',
				})
			);

			mockQuery.mockResolvedValueOnce({ Items: [] });

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1234567890,
			});

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					expect.objectContaining({
						pk: `${CANDLE_PK}#SOL-PERP#1`,
						sk: '1234567890',
						symbol: 'SOL-PERP',
						resolution: '1',
						ts: 1234567890,
						fillOpen: 100,
						oracleOpen: 100,
						fillHigh: 100,
						fillLow: 100,
						oracleHigh: 100,
						oracleLow: 100,
						fillClose: 100,
						oracleClose: 100,
						quoteVolume: 100,
						baseVolume: 1,
						lastTradeTs: 1234567890,
						lastFillRecordId: '987654321',
					}),
				],
			});
		});
	});

	describe('updateCandleOracle', () => {
		const { updateCandleOracle } = CandleRepository();

		const mockParams = {
			symbol: 'SOL-PERP',
			oraclePrice: 105,
			resolution: '1' as CandleResolutions,
			ts: 1234567890,
		};

		it('should update existing candle oracle close price', async () => {
			const existingCandle = {
				symbol: 'SOL-PERP',
				oracleHigh: 110,
				oracleLow: 95,
				oracleClose: 100,
			};

			mockUpdate.mockResolvedValueOnce({ Attributes: existingCandle });

			await updateCandleOracle(mockParams);

			expect(mockUpdate).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET oracleClose = :oraclePrice',
				expressionValues: {
					':oraclePrice': 105,
				},
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});
		});

		it('should update oracle high when new price is higher', async () => {
			const existingCandle = {
				symbol: 'SOL-PERP',
				oracleHigh: 100,
				oracleLow: 95,
				oracleClose: 100,
			};

			mockUpdate
				.mockResolvedValueOnce({ Attributes: existingCandle })
				.mockResolvedValueOnce({ Attributes: { ...existingCandle, oracleHigh: 105 } });

			await updateCandleOracle({ ...mockParams, oraclePrice: 105 });

			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenNthCalledWith(2, {
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET oracleHigh = :newOracleHigh',
				expressionValues: {
					':newOracleHigh': 105,
				},
			});
		});

		it('should update oracle low when new price is lower', async () => {
			const existingCandle = {
				symbol: 'SOL-PERP',
				oracleHigh: 110,
				oracleLow: 100,
				oracleClose: 105,
			};

			mockUpdate
				.mockResolvedValueOnce({ Attributes: existingCandle })
				.mockResolvedValueOnce({ Attributes: { ...existingCandle, oracleLow: 90 } });

			await updateCandleOracle({ ...mockParams, oraclePrice: 90 });

			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenNthCalledWith(2, {
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET oracleLow = :newOracleLow',
				expressionValues: {
					':newOracleLow': 90,
				},
			});
		});

		it('should update both oracle high and low when needed', async () => {
			const existingCandle = {
				symbol: 'SOL-PERP',
				oracleHigh: null,
				oracleLow: null,
				oracleClose: 100,
			};

			mockUpdate.mockResolvedValueOnce({ Attributes: existingCandle }).mockResolvedValueOnce({
				Attributes: {
					...existingCandle,
					oracleHigh: 105,
					oracleLow: 105,
				},
			});

			await updateCandleOracle({ ...mockParams, oraclePrice: 105 });

			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenNthCalledWith(2, {
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET oracleHigh = :newOracleHigh, oracleLow = :newOracleLow',
				expressionValues: {
					':newOracleHigh': 105,
					':newOracleLow': 105,
				},
			});
		});

		it('should not update high/low when price is within range', async () => {
			const existingCandle = {
				symbol: 'SOL-PERP',
				oracleHigh: 110,
				oracleLow: 95,
				oracleClose: 100,
			};

			mockUpdate.mockResolvedValueOnce({ Attributes: existingCandle });

			await updateCandleOracle({ ...mockParams, oraclePrice: 102 });

			expect(mockUpdate).toHaveBeenCalledTimes(1);
			expect(mockUpdate).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET oracleClose = :oraclePrice',
				expressionValues: {
					':oraclePrice': 102,
				},
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});
		});

		it('should create new candle when conditional check fails', async () => {
			const previousCandle = {
				fillClose: 98,
				oracleClose: 99,
			};

			mockUpdate.mockRejectedValueOnce(
				new ConditionalCheckFailedException({
					$metadata: {},
					message: 'The conditional request failed',
				})
			);

			mockQuery.mockResolvedValueOnce({ Items: [previousCandle] });

			await updateCandleOracle(mockParams);

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				expression: 'pk = :pk',
				expressionValues: {
					':pk': `${CANDLE_PK}#SOL-PERP#1`,
				},
				limit: 1,
			});

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					expect.objectContaining({
						pk: `${CANDLE_PK}#SOL-PERP#1`,
						sk: '1234567890',
						symbol: 'SOL-PERP',
						resolution: '1',
						ts: 1234567890,
						fillOpen: 98,
						fillHigh: 98,
						fillLow: 98,
						fillClose: 98,
						oracleOpen: 99,
						oracleHigh: 105, // Math.max(99, 105)
						oracleLow: 99, // Math.min(99, 105)
						oracleClose: 105,
						quoteVolume: 0,
						baseVolume: 0,
					}),
				],
			});
		});

		it('should re-throw non-ConditionalCheckFailedException errors', async () => {
			const customError = new Error('DynamoDB service error');
			mockUpdate.mockRejectedValueOnce(customError);

			await expect(updateCandleOracle(mockParams)).rejects.toThrow('DynamoDB service error');
		});

		it('should handle undefined oracle high/low correctly', async () => {
			const existingCandle = {
				symbol: 'SOL-PERP',
				oracleHigh: undefined,
				oracleLow: undefined,
				oracleClose: 100,
			};

			mockUpdate.mockResolvedValueOnce({ Attributes: existingCandle }).mockResolvedValueOnce({
				Attributes: {
					...existingCandle,
					oracleHigh: 105,
					oracleLow: 105,
				},
			});

			await updateCandleOracle(mockParams);

			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenNthCalledWith(2, {
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
				updateExpression: 'SET oracleHigh = :newOracleHigh, oracleLow = :newOracleLow',
				expressionValues: {
					':newOracleHigh': 105,
					':newOracleLow': 105,
				},
			});
		});

		it('should return null when conditional check fails and no previous candle exists', async () => {
			mockUpdate.mockRejectedValueOnce(
				new ConditionalCheckFailedException({
					$metadata: {},
					message: 'The conditional request failed',
				})
			);

			// Mock getLatestCandle returning no results (no trades occurred)
			mockQuery.mockResolvedValueOnce({ Items: [] });

			const result = await updateCandleOracle({
				symbol: 'SOL-PERP',
				oraclePrice: 105,
				resolution: '1',
				ts: 1234567890,
			});

			expect(result).toBeNull();
			expect(mockQuery).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				expression: 'pk = :pk',
				expressionValues: {
					':pk': `${CANDLE_PK}#SOL-PERP#1`,
				},
				limit: 1,
			});
			expect(mockBatchWrite).not.toHaveBeenCalled();
		});

		it('should create candle when conditional check fails but previous candle exists', async () => {
			const previousCandle = {
				fillClose: 98,
				oracleClose: 99,
			};

			mockUpdate.mockRejectedValueOnce(
				new ConditionalCheckFailedException({
					$metadata: {},
					message: 'The conditional request failed',
				})
			);

			mockQuery.mockResolvedValueOnce({ Items: [previousCandle] });

			const result = await updateCandleOracle({
				symbol: 'SOL-PERP',
				oraclePrice: 105,
				resolution: '1',
				ts: 1234567890,
			});

			expect(result).not.toBeNull();
			expect(mockQuery).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				expression: 'pk = :pk',
				expressionValues: {
					':pk': `${CANDLE_PK}#SOL-PERP#1`,
				},
				limit: 1,
			});

			expect(mockBatchWrite).toHaveBeenCalledWith({
				records: [
					expect.objectContaining({
						pk: `${CANDLE_PK}#SOL-PERP#1`,
						sk: '1234567890',
						symbol: 'SOL-PERP',
						resolution: '1',
						ts: 1234567890,
						fillOpen: 98,
						fillHigh: 98,
						fillLow: 98,
						fillClose: 98,
						oracleOpen: 99,
						oracleHigh: 105,
						oracleLow: 99,
						oracleClose: 105,
						quoteVolume: 0,
						baseVolume: 0,
					}),
				],
			});
		});
	});

	describe('getLatestCandle', () => {
		it('should call query with correct parameters', async () => {
			mockQuery.mockResolvedValue({ Items: [] });

			await getLatestCandle('SOL-PERP', '1');

			expect(mockQuery).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				expression: 'pk = :pk',
				expressionValues: {
					':pk': `${CANDLE_PK}#SOL-PERP#1`,
				},
				limit: 1,
			});
		});

		it('should return first item from query', async () => {
			const mockCandle = {
				symbol: 'SOL-PERP',
				resolution: '1',
				lastFillRecordId: '987654321',
			};
			mockQuery.mockResolvedValue({ Items: [mockCandle] });

			const result = await getLatestCandle('SOL-PERP', '1');

			expect(result).toBe(mockCandle);
		});
	});

	describe('getCandle', () => {
		it('should call get with correct parameters', async () => {
			const mockCandle = {
				symbol: 'SOL-PERP',
				resolution: '1',
				lastFillRecordId: '987654321',
			};
			mockGet.mockResolvedValue({ Item: mockCandle });
			const result = await getCandle('SOL-PERP', '1', 1234567890);
			expect(mockGet).toHaveBeenCalledWith({
				pk: `${CANDLE_PK}#SOL-PERP#1`,
				sk: '1234567890',
			});
			expect(result).toBe(mockCandle);
		});
	});

	describe('getCandlesForResolution', () => {
		it('should call query with correct parameters', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: null });

			await getCandlesForResolution({
				symbol: 'SOL-PERP',
				resolution: '1',
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'CANDLE#SOL-PERP#1',
				expression: 'pk = :pk',
				expressionValues: {
					':pk': 'CANDLE#SOL-PERP#1',
				},
				limit: 100,
			});
		});
	});

	describe('getCandlesBetweenTimestampsForResolution', () => {
		it('should call query with correct parameters', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: null });

			await getCandlesBetweenTimestampsForResolution({
				symbol: 'SOL-PERP',
				resolution: '1',
				startTs: 1234567890,
				endTs: 1234567900,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: 'CANDLE#SOL-PERP#1',
				expression: 'pk = :pk AND sk BETWEEN :endSk AND :startSk',
				expressionValues: {
					':pk': `${CANDLE_PK}#SOL-PERP#1`,
					':endSk': '1234567900',
					':startSk': '1234567890',
				},
				limit: 20,
				lastEvaluatedKey: undefined,
			});
		});
	});
});
