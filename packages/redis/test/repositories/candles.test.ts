import { CandleResolutions, TradeRecord } from '@backend/common';
import { Redis } from '../../src/client';
import { CandleCacheRepository } from '../../src/repositories/candles';

jest.mock('../../src/client', () => ({
	Redis: jest.fn(),
}));

describe('CandleCacheRepository', () => {
	const mockCandle = {
		symbol: 'BTC-USD',
		resolution: '1' as CandleResolutions,
		ts: 1000000,
		fillOpen: 50000,
		fillHigh: 51000,
		fillLow: 49000,
		fillClose: 50500,
		oracleOpen: 50100,
		oracleHigh: 51100,
		oracleLow: 49100,
		oracleClose: 50600,
		quoteVolume: 100,
		baseVolume: 2,
		lastTradeTs: 1000000,
	};

	const mockTrade = {
		symbol: 'BTC-USD',
		price: 50000,
		oraclePrice: 50100,
		quoteAssetAmountFilled: 50,
		baseAssetAmountFilled: 1,
		ts: 1000001,
		fillRecordId: '123',
	} as unknown as TradeRecord & { price: number };

	const mockRedis = {
		get: jest.fn(),
		mGet: jest.fn(),
		set: jest.fn(),
		setEx: jest.fn(),
		zAdd: jest.fn(),
		zCard: jest.fn(),
		zRange: jest.fn(),
		zRangeByScore: jest.fn(),
		zRemRangeByRank: jest.fn(),
		zRangeWithScores: jest.fn(),
		publish: jest.fn(),
	};

	(Redis as jest.Mock).mockReturnValue(mockRedis);

	const {
		getLatestCandle,
		getCandle,
		createCandleRecords,
		updateCandleRecord,
		getCandlesForResolution,
		getCandlesBetweenTimestampsForResolution,
		clearBuffers,
		publishBufferedUpdates,
		generateCandleKey,
		generateSetKey,
		generateCandleChannel,
		updateCandleOracle,
	} = CandleCacheRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('getLatestCandle', () => {
		it('should return undefined when no candles exist', async () => {
			mockRedis.zRangeWithScores.mockResolvedValue([]);

			const result = await getLatestCandle('BTC-USD', '1');
			expect(result).toBeUndefined();
		});

		it('should return the latest candle', async () => {
			const candleKey = 'candle:{BTC-USD:1}:1000000';
			mockRedis.zRangeWithScores.mockResolvedValue([{ value: candleKey, score: 1000000 }]);
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			const result = await getLatestCandle('BTC-USD', '1');
			expect(result).toEqual(mockCandle);
		});
	});

	describe('getCandle', () => {
		it('should return undefined when candle does not exist', async () => {
			mockRedis.get.mockResolvedValue(null);

			const result = await getCandle('BTC-USD', '1', 1000000);
			expect(result).toBeUndefined();
		});

		it('should return candle when it exists', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			const result = await getCandle('BTC-USD', '1', 1000000);
			expect(result).toEqual(mockCandle);
		});
	});

	describe('createCandleRecords', () => {
		it('should create multiple candles and add to buffer', async () => {
			const candles = [mockCandle];
			await createCandleRecords(candles);

			expect(mockRedis.setEx).toHaveBeenCalledWith(
				expect.stringContaining('candle:{BTC-USD:1}:'),
				expect.any(Number),
				JSON.stringify(mockCandle)
			);
			expect(mockRedis.zAdd).toHaveBeenCalled();
		});

		it('should trim candle set if it exceeds maximum size', async () => {
			mockRedis.zCard.mockResolvedValue(1010);
			await createCandleRecords([mockCandle]);

			expect(mockRedis.zRemRangeByRank).toHaveBeenCalledWith('candleset:{BTC-USD:1}', 0, 9);
		});
	});

	describe('updateCandleRecord', () => {
		it('should create new candle when none exists', async () => {
			mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

			const result = await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.fillOpen).toBe(mockTrade.price);
			expect(result.lastFillRecordId).toBe(mockTrade.fillRecordId);
			expect(mockRedis.publish).not.toHaveBeenCalled();
		});

		it('should update existing candle', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			const result = await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.fillClose).toBe(mockTrade.price);
			expect(result.lastFillRecordId).toBe(mockTrade.fillRecordId);

			expect(mockRedis.set).toHaveBeenCalledWith(
				'candle:{BTC-USD:1}:1000000',
				expect.stringContaining('"lastFillRecordId":"123"')
			);
		});

		it('should handle updateOpenOnly flag', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			const result = await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1000000,
				updateOpenOnly: true,
			});

			expect(result.fillOpen).toBe(mockTrade.price);
			expect(result.fillClose).toBe(mockCandle.fillClose);

			expect(mockRedis.set).toHaveBeenCalledWith(
				'candle:{BTC-USD:1}:1000000',
				JSON.stringify({
					...mockCandle,
					fillOpen: mockTrade.price,
					oracleOpen: mockTrade.oraclePrice,
				})
			);
		});

		it('should handle updateEmptyCandle flag', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			const result = await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1000000,
				updateEmptyCandle: true,
			});

			expect(result.fillOpen).toBe(mockTrade.price);
			expect(result.fillHigh).toBe(mockTrade.price);
			expect(result.fillLow).toBe(mockTrade.price);
			expect(result.fillClose).toBe(mockTrade.price);

			expect(mockRedis.set).toHaveBeenCalledWith(
				'candle:{BTC-USD:1}:1000000',
				expect.stringContaining(
					'"fillOpen":50000,"fillHigh":50000,"fillLow":50000,"fillClose":50000'
				)
			);
		});

		it('should not update lastFillRecordId if trade has older fillRecordId', async () => {
			const candleWithFillRecordId = {
				...mockCandle,
				lastFillRecordId: 200,
			};

			mockRedis.get.mockResolvedValue(JSON.stringify(candleWithFillRecordId));

			const result = await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.fillClose).toBe(mockCandle.fillClose);
			expect(result.lastFillRecordId).toBe(200);
		});
	});

	describe('updateCandleOracle', () => {
		it('should create new candle using previous candle close prices as open', async () => {
			const previousCandle = {
				...mockCandle,
				fillClose: 49500,
				oracleClose: 49600,
			};

			mockRedis.get
				.mockResolvedValueOnce(null)
				.mockResolvedValue(JSON.stringify(previousCandle));
			mockRedis.zRangeWithScores.mockResolvedValueOnce(['test-candle']);

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 50500,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.fillOpen).toBe(49500);
			expect(result.fillHigh).toBe(49500);
			expect(result.fillLow).toBe(49500);
			expect(result.fillClose).toBe(49500);
			expect(result.oracleOpen).toBe(49600);
			expect(result.oracleHigh).toBe(50500);
			expect(result.oracleLow).toBe(49600);
			expect(result.oracleClose).toBe(50500);
		});

		it('should update existing candle oracle prices', async () => {
			const existingCandle = {
				...mockCandle,
				oracleHigh: 50800,
				oracleLow: 49800,
				oracleClose: 50300,
			};

			mockRedis.get.mockResolvedValue(JSON.stringify(existingCandle));

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 51200,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.oracleHigh).toBe(51200);
			expect(result.oracleLow).toBe(49800);
			expect(result.oracleClose).toBe(51200);
			expect(result.fillOpen).toBe(existingCandle.fillOpen);
			expect(result.fillClose).toBe(existingCandle.fillClose);
			expect(result.quoteVolume).toBe(existingCandle.quoteVolume);
			expect(result.baseVolume).toBe(existingCandle.baseVolume);

			expect(mockRedis.set).toHaveBeenCalledWith(
				'candle:{BTC-USD:1}:1000000',
				JSON.stringify(result)
			);
		});

		it('should update oracle low when new price is lower', async () => {
			const existingCandle = {
				...mockCandle,
				oracleHigh: 50800,
				oracleLow: 49800,
				oracleClose: 50300,
			};

			mockRedis.get.mockResolvedValue(JSON.stringify(existingCandle));

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 49200,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.oracleHigh).toBe(50800);
			expect(result.oracleLow).toBe(49200);
			expect(result.oracleClose).toBe(49200);
		});

		it('should handle candle with null oracle high/low values', async () => {
			const existingCandle = {
				...mockCandle,
				oracleHigh: null,
				oracleLow: null,
				oracleClose: 50300,
			};

			mockRedis.get.mockResolvedValue(JSON.stringify(existingCandle));

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 50500,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.oracleHigh).toBe(50500);
			expect(result.oracleLow).toBe(50500);
			expect(result.oracleClose).toBe(50500);
		});

		it('should add candle to buffer without marking as new candle', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			clearBuffers();

			await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 50500,
				resolution: '1',
				ts: 1000000,
			});

			await publishBufferedUpdates();

			expect(mockRedis.publish).toHaveBeenCalledWith(
				'candles:BTC-USD:1',
				expect.stringContaining('"type":"update"')
			);
		});

		it('should add new candle to set with correct score', async () => {
			mockRedis.get.mockResolvedValue(null).mockResolvedValue(null);
			mockRedis.zRangeWithScores.mockResolvedValue([]);

			await updateCandleOracle({
				symbol: 'ETH-USD',
				oraclePrice: 3000,
				resolution: '5',
				ts: 2000000,
			});

			expect(mockRedis.zAdd).not.toHaveBeenCalled();
		});

		it('should preserve fill prices when updating existing candle', async () => {
			const existingCandle = {
				...mockCandle,
				fillOpen: 48000,
				fillHigh: 52000,
				fillLow: 47000,
				fillClose: 51000,
			};

			mockRedis.get.mockResolvedValue(JSON.stringify(existingCandle));

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 50500,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.fillOpen).toBe(48000);
			expect(result.fillHigh).toBe(52000);
			expect(result.fillLow).toBe(47000);
			expect(result.fillClose).toBe(51000);
		});

		it('should preserve volumes when updating existing candle', async () => {
			const existingCandle = {
				...mockCandle,
				quoteVolume: 250.5,
				baseVolume: 5.1,
			};

			mockRedis.get.mockResolvedValue(JSON.stringify(existingCandle));

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 50500,
				resolution: '1',
				ts: 1000000,
			});

			expect(result.quoteVolume).toBe(250.5);
			expect(result.baseVolume).toBe(5.1);
		});

		it('should return null when no previous candles exist (no trades occurred)', async () => {
			mockRedis.get.mockResolvedValue(null);
			mockRedis.zRangeWithScores.mockResolvedValue([]);

			const result = await updateCandleOracle({
				symbol: 'BTC-USD',
				oraclePrice: 50500,
				resolution: '1',
				ts: 1000000,
			});

			expect(result).toBeNull();
			expect(mockRedis.set).not.toHaveBeenCalled();
			expect(mockRedis.zAdd).not.toHaveBeenCalled();
		});

		it('should return null when getLatestCandle returns null (no trades occurred)', async () => {
			mockRedis.get.mockResolvedValue(null);
			mockRedis.get.mockResolvedValue(null);

			const result = await updateCandleOracle({
				symbol: 'ETH-USD',
				oraclePrice: 3000,
				resolution: '5',
				ts: 2000000,
			});

			expect(result).toBeNull();
			expect(mockRedis.set).not.toHaveBeenCalled();
			expect(mockRedis.zAdd).not.toHaveBeenCalled();
		});
	});

	describe('getCandlesForResolution', () => {
		it('should return empty array when no candles exist', async () => {
			mockRedis.zRange.mockResolvedValue([]);

			const result = await getCandlesForResolution({ symbol: 'BTC-USD', resolution: '1' });
			expect(result).toEqual([]);
		});

		it('should return candles sorted by timestamp descending', async () => {
			const candle1 = { ...mockCandle, ts: 1000060 };
			const candle2 = { ...mockCandle, ts: 1000000 };

			mockRedis.zRange.mockResolvedValue(['key1', 'key2']);
			mockRedis.mGet.mockResolvedValue([JSON.stringify(candle1), JSON.stringify(candle2)]);

			const result = await getCandlesForResolution({ symbol: 'BTC-USD', resolution: '1' });
			expect(result).toHaveLength(2);
			expect(result[0].ts).toBe(1000060);
			expect(result[1].ts).toBe(1000000);
		});

		it('should respect limit parameter', async () => {
			await getCandlesForResolution({ symbol: 'BTC-USD', resolution: '1', limit: 50 });

			expect(mockRedis.zRange).toHaveBeenCalledWith(
				expect.any(String),
				Infinity,
				-Infinity,
				true,
				50
			);
		});
	});

	describe('getCandlesBetweenTimestampsForResolution', () => {
		it('should return empty array when no candles exist', async () => {
			mockRedis.zRange.mockResolvedValue([]);

			const result = await getCandlesBetweenTimestampsForResolution({
				symbol: 'BTC-USD',
				resolution: '1',
				startTs: 1000000,
				endTs: 1000060,
			});
			expect(result).toEqual([]);
		});

		it('should return candles within timestamp range sorted descending', async () => {
			const candle1 = { ...mockCandle, ts: 1000060 };
			const candle2 = { ...mockCandle, ts: 1000000 };

			mockRedis.zRange.mockResolvedValue(['key1', 'key2']);
			mockRedis.mGet.mockResolvedValue([JSON.stringify(candle1), JSON.stringify(candle2)]);

			const result = await getCandlesBetweenTimestampsForResolution({
				symbol: 'BTC-USD',
				resolution: '1',
				startTs: 1000060,
				endTs: 1000000,
			});

			expect(result).toHaveLength(2);
			expect(result[0].ts).toBe(1000060);
			expect(result[1].ts).toBe(1000000);
		});
	});

	describe('publishBufferedUpdates', () => {
		it('should publish buffered updates after createCandleRecords', async () => {
			clearBuffers();
			await createCandleRecords([mockCandle]);
			await publishBufferedUpdates();

			expect(mockRedis.publish).toHaveBeenCalledWith(
				'candles:BTC-USD:1',
				JSON.stringify({
					type: 'create',
					candle: mockCandle,
					trades: [],
				})
			);
		});

		it('should publish buffered updates after updateCandleRecord', async () => {
			mockRedis.get.mockResolvedValue(JSON.stringify(mockCandle));

			await updateCandleRecord({
				trade: mockTrade,
				resolution: '1',
				ts: 1000000,
			});

			await publishBufferedUpdates();

			expect(mockRedis.publish).toHaveBeenCalledWith(
				'candles:BTC-USD:1',
				expect.stringContaining('"type":"update"')
			);
		});

		it('should clear buffer after publishing', async () => {
			await createCandleRecords([mockCandle]);
			await publishBufferedUpdates();

			mockRedis.publish.mockClear();
			await publishBufferedUpdates();
			expect(mockRedis.publish).not.toHaveBeenCalled();
		});
	});

	describe('helper functions', () => {
		it('should generate correct candle key', () => {
			const key = generateCandleKey('BTC-USD', '1', 1000000);
			expect(key).toBe('candle:{BTC-USD:1}:1000000');
		});

		it('should generate correct set key', () => {
			const key = generateSetKey('BTC-USD', '1');
			expect(key).toBe('candleset:{BTC-USD:1}');
		});

		it('should generate correct channel name', () => {
			const channel = generateCandleChannel('BTC-USD', '1');
			expect(channel).toBe('candles:BTC-USD:1');
		});
	});
});
