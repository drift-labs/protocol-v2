import {
	CandleRecord,
	CandleResolutions,
	NotificationType,
	OraclePriceData,
	TradeRecord,
} from '@backend/common';
import { CandleProcessor } from '../src/services/candle-processor';

const mockGetMessages = jest.fn();
const mockDeleteMessages = jest.fn();
const mockPutMessages = jest.fn();
jest.mock('@backend/sqs', () => ({
	SQS: () => ({
		getMessages: mockGetMessages,
		deleteMessages: mockDeleteMessages,
		putMessages: mockPutMessages,
	}),
}));

const mockGetLatestCandle = jest.fn();
const mockCreateCandleRecords = jest.fn();
const mockUpdateCandleRecord = jest.fn();
const mockGetCandle = jest.fn();
const mockUpdateCandleOracle = jest.fn();
const mockPut = jest.fn();
jest.mock('@backend/dynamodb', () => ({
	CandleRepository: () => ({
		getLatestCandle: mockGetLatestCandle,
		createCandleRecords: mockCreateCandleRecords,
		updateCandleRecord: mockUpdateCandleRecord,
		getCandle: mockGetCandle,
		updateCandleOracle: mockUpdateCandleOracle,
	}),
	DynamoDB: () => ({
		put: mockPut,
	}),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	isFeatureEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('bottleneck', () => {
	return jest.fn().mockImplementation(() => ({
		schedule: jest.fn().mockImplementation((fn) => fn()),
	}));
});

const SYMBOLS = ['SOL-PERP', 'BTC-PERP'];

describe('CandleProcessor', () => {
	const {
		getCandleTimestamp,
		getRelevantResolutions,
		findAndFillCandleGaps,
		checkAndCreateEmptyCandles,
		getTradeInformationFromMessage,
		getOracleInformationFromMessage,
		processTrade,
		processOraclePrice,
	} = CandleProcessor({
		symbols: SYMBOLS,
		isRunning: true,
	});

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('getCandleTimestamp', () => {
		it('should return correct timestamp for all resolutions', () => {
			const testTime = 1732588401;
			const cases: [CandleResolutions, number][] = [
				['1', 1732588380],
				['5', 1732588200],
				['15', 1732588200],
				['60', 1732586400],
				['240', 1732579200],
				['D', 1732579200],
				['W', 1732492800],
				['M', 1730419200],
			];
			cases.forEach(([resolution, expected]) => {
				expect(getCandleTimestamp(testTime, resolution)).toBe(expected);
			});
		});
	});

	describe('getRelevantResolutions', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});
		afterEach(() => {
			jest.useRealTimers();
		});

		it('should return empty array if seconds is not 0', () => {
			jest.setSystemTime(new Date('2024-01-01T00:00:01Z'));
			expect(getRelevantResolutions()).toEqual([]);
		});

		it('should return 1min on every minute', () => {
			jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
			expect(getRelevantResolutions()).toContain('1');
		});

		it('should return 5min resolutions correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T00:05:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
		});

		it('should return 15min resolutions correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T00:15:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
			expect(result).toContain('15');
		});

		it('should return hourly resolution correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T01:00:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
			expect(result).toContain('15');
			expect(result).toContain('60');
		});

		it('should return 4h resolution correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T04:00:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
			expect(result).toContain('15');
			expect(result).toContain('60');
			expect(result).toContain('240');
		});

		it('should return daily resolution correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
			expect(result).toContain('15');
			expect(result).toContain('60');
			expect(result).toContain('240');
			expect(result).toContain('D');
		});

		it('should return weekly resolution correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
			expect(result).toContain('15');
			expect(result).toContain('60');
			expect(result).toContain('240');
			expect(result).toContain('D');
			expect(result).toContain('W');
		});

		it('should return monthly resolution correctly', () => {
			jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
			const result = getRelevantResolutions();
			expect(result).toContain('1');
			expect(result).toContain('5');
			expect(result).toContain('15');
			expect(result).toContain('60');
			expect(result).toContain('240');
			expect(result).toContain('D');
			expect(result).toContain('W');
			expect(result).toContain('M');
		});
	});

	describe('findAndFillCandleGaps', () => {
		it('should return empty array if no lastCandle', async () => {
			const result = await findAndFillCandleGaps({
				symbol: 'SOL-PERP',
				resolution: '1',
				currentTimestamp: 1730953095,
				lastCandle: undefined,
			});

			expect(result).toEqual([]);
		});

		it('should return empty array if no gaps', async () => {
			const currentTimestamp = 1730953095;
			const lastCandle: CandleRecord = {
				symbol: 'SOL-PERP',
				resolution: '1',
				ts: currentTimestamp - 60,
				fillOpen: 100,
				fillClose: 100,
				fillHigh: 100,
				fillLow: 100,
				oracleOpen: 100,
				oracleClose: 100,
				oracleHigh: 100,
				oracleLow: 100,
				baseVolume: 0,
				quoteVolume: 0,
			};

			const result = await findAndFillCandleGaps({
				symbol: 'SOL-PERP',
				resolution: '1',
				currentTimestamp,
				lastCandle,
			});

			expect(result).toEqual([]);
		});

		it('should fill gaps correctly', async () => {
			const currentTimestamp = 1730953095;
			const lastCandle: CandleRecord = {
				symbol: 'SOL-PERP',
				resolution: '1',
				ts: currentTimestamp - 300,
				fillOpen: 100,
				fillClose: 100,
				fillHigh: 100,
				fillLow: 100,
				oracleOpen: 100,
				oracleClose: 100,
				oracleHigh: 100,
				oracleLow: 100,
				baseVolume: 0,
				quoteVolume: 0,
			};

			const result = await findAndFillCandleGaps({
				symbol: 'SOL-PERP',
				resolution: '1',
				currentTimestamp,
				lastCandle,
			});

			expect(result.length).toBe(4);
			expect(result[0].ts).toBe(lastCandle.ts + 60);
			expect(result[0].fillOpen).toBe(100);
			expect(result[0].fillClose).toBe(100);
			expect(result[result.length - 1].ts).toBe(lastCandle.ts + 240);
		});

		it('should handle undefined lastCandle', async () => {
			const result = await findAndFillCandleGaps({
				symbol: 'SOL-PERP',
				resolution: '1',
				currentTimestamp: 1730953095,
				lastCandle: undefined,
			});

			expect(result).toEqual([]);
		});
	});

	describe('getTradeInformationFromMessage', () => {
		const createDynamoDbEvent = (overrides: any = {}) =>
			JSON.stringify({
				detail: {
					eventName: overrides.eventName || 'MODIFY',
					dynamodb: {
						NewImage: {
							symbol: { S: 'SOL-PERP' },
							source: { S: 'seq' },
							baseAssetAmountFilled: { N: '0.1' },
							quoteAssetAmountFilled: { N: '19' },
							ts: { N: '1730953095' },
							...overrides.NewImage,
						},
						OldImage: {
							symbol: { S: 'SOL-PERP' },
							source: { S: 'seq' },
							baseAssetAmountFilled: { N: '0.05' },
							quoteAssetAmountFilled: { N: '9.5' },
							ts: { N: '1730953095' },
							...overrides.OldImage,
						},
						...overrides.dynamodb,
					},
				},
			});

		it('should handle undefined body', () => {
			const result = getTradeInformationFromMessage(undefined);
			expect(result).toBeUndefined();
		});

		it('should handle empty JSON', () => {
			const result = getTradeInformationFromMessage('{}');
			expect(result).toBeUndefined();
		});

		it('should handle invalid JSON', () => {
			const result = getTradeInformationFromMessage('invalid json');
			expect(result).toBeUndefined();
		});

		it('should handle missing NewImage', () => {
			const event = createDynamoDbEvent({
				dynamodb: {
					NewImage: null,
					OldImage: null,
				},
			});
			const result = getTradeInformationFromMessage(event);
			expect(result).toBeUndefined();
		});

		it('should handle INSERT events with source', () => {
			const event = createDynamoDbEvent({
				eventName: 'INSERT',
			});
			const result = getTradeInformationFromMessage(event);
			expect(result).toEqual({
				symbol: 'SOL-PERP',
				source: 'seq',
				baseAssetAmountFilled: 0.1,
				quoteAssetAmountFilled: 19,
				ts: 1730953095,
			});
		});

		it('should handle INSERT events without source', () => {
			const event = createDynamoDbEvent({
				eventName: 'INSERT',
				NewImage: {
					symbol: { S: 'SOL-PERP' },
					source: undefined,
				},
				dynamodb: {
					OldImage: null,
				},
			});
			const result = getTradeInformationFromMessage(event);
			expect(result).toBeUndefined();
		});

		describe('MODIFY events', () => {
			it('should calculate volume difference for same source', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						source: { S: 'seq' },
						baseAssetAmountFilled: { N: '0.1' },
						quoteAssetAmountFilled: { N: '19' },
					},
					OldImage: {
						source: { S: 'seq' },
						baseAssetAmountFilled: { N: '0.05' },
						quoteAssetAmountFilled: { N: '9.5' },
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toEqual({
					symbol: 'SOL-PERP',
					source: 'seq',
					baseAssetAmountFilled: 0.05,
					quoteAssetAmountFilled: 9.5,
					ts: 1730953095,
				});
			});

			it('should return undefined if no volume difference', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						baseAssetAmountFilled: { N: '0.1' },
						quoteAssetAmountFilled: { N: '19' },
					},
					OldImage: {
						baseAssetAmountFilled: { N: '0.1' },
						quoteAssetAmountFilled: { N: '19' },
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toBeUndefined();
			});

			it('should handle volume decrease', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						baseAssetAmountFilled: { N: '0.05' },
						quoteAssetAmountFilled: { N: '9.5' },
					},
					OldImage: {
						baseAssetAmountFilled: { N: '0.1' },
						quoteAssetAmountFilled: { N: '19' },
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toEqual({
					symbol: 'SOL-PERP',
					source: 'seq',
					baseAssetAmountFilled: -0.05,
					quoteAssetAmountFilled: -9.5,
					ts: 1730953095,
				});
			});

			it('should return full NewImage if sources are different', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						source: { S: 'seq' },
						baseAssetAmountFilled: { N: '0.1' },
						quoteAssetAmountFilled: { N: '19' },
					},
					OldImage: {
						source: { S: 'grpc' },
						baseAssetAmountFilled: { N: '0.1' },
						quoteAssetAmountFilled: { N: '19' },
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toEqual({
					symbol: 'SOL-PERP',
					source: 'seq',
					baseAssetAmountFilled: 0.1,
					quoteAssetAmountFilled: 19,
					ts: 1730953095,
				});
			});
		});

		describe('Edge cases', () => {
			it('should handle missing source field', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						source: undefined,
					},
					OldImage: {
						source: undefined,
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toBeUndefined();
			});

			it('should handle missing filled amounts', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						baseAssetAmountFilled: undefined,
						quoteAssetAmountFilled: undefined,
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toEqual(
					expect.objectContaining({
						symbol: 'SOL-PERP',
						source: 'seq',
					})
				);
			});

			it('should handle string numbers correctly', () => {
				const event = createDynamoDbEvent({
					NewImage: {
						baseAssetAmountFilled: { N: '0.100000' },
						quoteAssetAmountFilled: { N: '19.000000' },
					},
					OldImage: {
						baseAssetAmountFilled: { N: '0.050000' },
						quoteAssetAmountFilled: { N: '9.500000' },
					},
				});

				const result = getTradeInformationFromMessage(event);
				expect(result).toEqual({
					symbol: 'SOL-PERP',
					source: 'seq',
					baseAssetAmountFilled: 0.05,
					quoteAssetAmountFilled: 9.5,
					ts: 1730953095,
				});
			});
		});
	});

	describe('getOracleInformationFromMessage', () => {
		it('should handle undefined body', () => {
			const result = getOracleInformationFromMessage(undefined);
			expect(result).toBeUndefined();
		});

		it('should handle empty JSON', () => {
			const result = getOracleInformationFromMessage('{}');
			expect(result).toBeUndefined();
		});

		it('should handle invalid JSON', () => {
			const result = getOracleInformationFromMessage('invalid');
			expect(result).toBeUndefined();
		});

		it('should handle non-price-alert messages', () => {
			const message = JSON.stringify({
				type: 'OTHER_TYPE',
				data: { symbol: 'SOL-PERP', price: 190 },
			});
			const result = getOracleInformationFromMessage(message);
			expect(result).toBeUndefined();
		});

		it('should parse valid oracle price message', () => {
			const oracleData = {
				symbol: 'SOL-PERP',
				price: 189.5,
				timestamp: 1730953095,
			};
			const message = JSON.stringify({
				Message: JSON.stringify({
					type: NotificationType.PRICE_ALERT,
					data: oracleData,
				}),
			});

			const result = getOracleInformationFromMessage(message);
			expect(result).toEqual(oracleData);
		});

		it('should handle message without data field', () => {
			const message = JSON.stringify({
				type: NotificationType.PRICE_ALERT,
			});
			const result = getOracleInformationFromMessage(message);
			expect(result).toBeUndefined();
		});
	});

	describe('processOraclePrice', () => {
		const mockOracleData = {
			symbol: 'SOL-PERP',
			price: 189.5,
			timestamp: 1730953095,
		} as OraclePriceData;

		it('should call updateCandleOracle when feature is enabled', async () => {
			await processOraclePrice(mockOracleData, '1');

			expect(mockUpdateCandleOracle).toHaveBeenCalledWith({
				symbol: 'SOL-PERP',
				oraclePrice: 189.5,
				resolution: '1',
				ts: getCandleTimestamp(1730953095, '1'),
			});
		});
	});

	describe('processTrade', () => {
		const mockTrade = {
			symbol: 'SOL-PERP',
			baseAssetAmountFilled: 0.1,
			quoteAssetAmountFilled: 19,
			oraclePrice: 189.686958,
			ts: 1730953095,
		} as TradeRecord;

		it('should process current trade correctly', async () => {
			mockUpdateCandleRecord.mockResolvedValue({
				fillClose: 190,
				oracleClose: 189.686958,
				lastTradeTs: mockTrade.ts,
			});

			await processTrade(mockTrade, '1');

			expect(mockUpdateCandleRecord).toHaveBeenCalledWith({
				trade: expect.objectContaining({
					price: 190,
				}),
				resolution: '1',
				ts: expect.any(Number),
			});
		});

		it('should update subsequent empty candles for historical trades', async () => {
			const now = Math.floor(Date.now() / 1000);
			const oneHourAgo = now - 3600; // 1 hour ago
			const historicalTrade = {
				...mockTrade,
				ts: oneHourAgo,
				baseAssetAmountFilled: 0.1,
				quoteAssetAmountFilled: 19,
			};

			mockUpdateCandleRecord.mockResolvedValue({
				fillClose: 190,
				oracleClose: 189.686958,
				lastTradeTs: oneHourAgo,
			});

			mockGetCandle.mockImplementation(() =>
				Promise.resolve({
					baseVolume: 0,
				})
			);

			await processTrade(historicalTrade, '1');

			expect(mockUpdateCandleRecord).toHaveBeenCalledTimes(61);

			const calls = mockUpdateCandleRecord.mock.calls;

			expect(calls[0][0]).toMatchObject({
				trade: {
					...historicalTrade,
					price: 190,
				},
				resolution: '1',
				ts: Math.floor(oneHourAgo / 60) * 60,
			});

			const lastTimestamp = Math.floor(oneHourAgo / 60) * 60;
			for (let i = 1; i < calls.length; i++) {
				const expectedTs = lastTimestamp + 60 * i;
				expect(calls[i][0]).toMatchObject({
					trade: {
						...historicalTrade,
						price: 190,
						oraclePrice: 189.686958,
					},
					resolution: '1',
					ts: expectedTs,
					updateEmptyCandle: true,
				});
			}

			const finalCall = calls[calls.length - 1][0];
			expect(finalCall.ts).toBe(Math.floor(now / 60) * 60);
		});

		it('should handle non-empty subsequent candles correctly', async () => {
			const historicalTs = Date.now() / 1000 - 3600;
			const historicalTrade = { ...mockTrade, ts: historicalTs };

			mockUpdateCandleRecord.mockResolvedValue({
				fillClose: 190,
				oracleClose: 189.686958,
				lastTradeTs: historicalTs,
			});

			mockGetCandle.mockResolvedValueOnce({
				baseVolume: 100,
			});

			await processTrade(historicalTrade, '1');
			const calls = mockUpdateCandleRecord.mock.calls;

			expect(mockUpdateCandleRecord).toHaveBeenCalledTimes(2);

			expect(calls[0][0]).toMatchObject({
				trade: {
					...historicalTrade,
					oraclePrice: 189.686958,
					price: 190,
				},
				resolution: '1',
				ts: expect.any(Number),
			});

			expect(calls[1][0]).toMatchObject({
				trade: {
					...historicalTrade,
					price: 190,
					oraclePrice: 189.686958,
				},
				resolution: '1',
				ts: expect.any(Number),
				updateOpenOnly: true,
			});
		});

		it('should stop updating when candle is not found', async () => {
			const historicalTs = Date.now() / 1000 - 3600;
			const historicalTrade = { ...mockTrade, ts: historicalTs };

			mockUpdateCandleRecord.mockResolvedValue({
				fillClose: 190,
				oracleClose: 189.686958,
				lastTradeTs: historicalTs,
			});

			mockGetCandle.mockResolvedValueOnce(null);

			await processTrade(historicalTrade, '1');

			expect(mockUpdateCandleRecord).toHaveBeenCalledTimes(1);
		});
	});

	describe('checkAndCreateEmptyCandles', () => {
		it('should not create candles when lastCandle is null', async () => {
			mockGetLatestCandle.mockResolvedValue(null);
			await checkAndCreateEmptyCandles({ force: true });
			expect(mockCreateCandleRecords).not.toHaveBeenCalled();
		});

		it('should only create relevant resolutions when not forced', async () => {
			jest.useFakeTimers();
			jest.setSystemTime(new Date('2024-01-01T00:01:00Z'));
			mockGetLatestCandle.mockResolvedValue({
				symbol: 'BTC-USD',
				resolution: '1',
				ts: Date.now() / 1000 - 60,
				fillOpen: 100,
				fillHigh: 100,
				fillClose: 100,
				fillLow: 100,
				oracleOpen: 100,
				oracleHigh: 100,
				oracleClose: 100,
				oracleLow: 100,
				quoteVolume: 0,
				baseVolume: 0,
			});
			await checkAndCreateEmptyCandles({ force: false });
			expect(mockCreateCandleRecords).toHaveBeenCalled();
			const createdCandles = mockCreateCandleRecords.mock.calls[0][0];
			expect(createdCandles.length).toBe(SYMBOLS.length);
		});
	});

	describe('processTrade - Trade Filtering', () => {
		const mockTrade: TradeRecord = {
			symbol: 'SOL-PERP',
			baseAssetAmountFilled: 0.1,
			quoteAssetAmountFilled: 19,
			oraclePrice: 190,
			ts: 1730953095,
			fillRecordId: '123',
		} as TradeRecord;

		beforeEach(() => {
			jest.clearAllMocks();
			mockUpdateCandleRecord.mockResolvedValue({
				fillClose: 190,
				oracleClose: 190,
				lastFillRecordId: '123',
			});
		});

		it('should not filter whitelisted markets', async () => {
			process.env.WHITELISTED_MARKETS = 'SOL-PERP';
			process.env.MIN_NOTIONAL = '1001';

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			const badTrade = {
				...mockTrade,
				quoteAssetAmountFilled: 1000,
				baseAssetAmountFilled: 0.1,
				oraclePrice: 190,
			};

			await processTrade(badTrade, '1');

			expect(mockPut).not.toHaveBeenCalled();
			expect(mockUpdateCandleRecord).toHaveBeenCalled();
			delete process.env.WHITELISTED_MARKETS;
		});

		it('should filter trades from blacklisted makers', async () => {
			process.env.BLACKLISTED_MAKERS = 'bad-maker';

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			const tradeWithBadMaker = {
				...mockTrade,
				maker: 'bad-maker',
			};

			await processTrade(tradeWithBadMaker, '1');

			expect(mockPut).toHaveBeenCalledWith({
				record: {
					...tradeWithBadMaker,
					pk: 'FILTERED_TRADE',
				},
			});
			expect(mockUpdateCandleRecord).not.toHaveBeenCalled();
		});

		it('should filter trades with high oracle deviation and low notional', async () => {
			process.env.MAX_PRICE_DEVIATION_PCT = '3';
			process.env.MIN_NOTIONAL_VALUE = '1000';

			const deviatedTrade = {
				...mockTrade,
				oraclePrice: 190,
				quoteAssetAmountFilled: 250, // Trade price would be 250/0.1 = 2500
				baseAssetAmountFilled: 0.1,
			};

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			await processTrade(deviatedTrade, '1');

			expect(mockPut).toHaveBeenCalledWith({
				record: {
					...deviatedTrade,
					pk: 'FILTERED_TRADE',
				},
			});
			expect(mockUpdateCandleRecord).not.toHaveBeenCalled();
		});

		it('should not filter trades with high oracle deviation but high notional', async () => {
			process.env.MAX_PRICE_DEVIATION_PCT = '3';
			process.env.MIN_NOTIONAL_VALUE = '100';

			const deviatedTrade = {
				...mockTrade,
				oraclePrice: 190,
				quoteAssetAmountFilled: 250, // Trade price would be 250/0.1 = 2500
				baseAssetAmountFilled: 0.1,
			};

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			await processTrade(deviatedTrade, '1');

			expect(mockPut).not.toHaveBeenCalled();
			expect(mockUpdateCandleRecord).toHaveBeenCalled();
		});

		it('should not filter trades within oracle deviation threshold', async () => {
			process.env.MAX_PRICE_DEVIATION_PCT = '3';
			process.env.MIN_NOTIONAL_VALUE = '1000';

			const goodTrade = {
				...mockTrade,
				oraclePrice: 190,
				quoteAssetAmountFilled: 194, // ~2% deviation
				baseAssetAmountFilled: 1,
			};

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			await processTrade(goodTrade, '1');

			expect(mockPut).not.toHaveBeenCalled();
			expect(mockUpdateCandleRecord).toHaveBeenCalled();
		});

		it('should handle edge case at exact deviation threshold', async () => {
			process.env.MAX_PRICE_DEVIATION_PCT = '3';
			process.env.MIN_NOTIONAL_VALUE = '1000';

			const edgeTrade = {
				...mockTrade,
				oraclePrice: 100,
				quoteAssetAmountFilled: 103, // Exactly 3% deviation
				baseAssetAmountFilled: 1,
			};

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			await processTrade(edgeTrade, '1');

			expect(mockPut).not.toHaveBeenCalled();
			expect(mockUpdateCandleRecord).toHaveBeenCalled();
		});

		it('should filter negative price deviations', async () => {
			process.env.MAX_PRICE_DEVIATION_PCT = '3';
			process.env.MIN_NOTIONAL_VALUE = '1000';

			const deviatedTrade = {
				...mockTrade,
				oraclePrice: 190,
				quoteAssetAmountFilled: 180, // ~5.3% negative deviation
				baseAssetAmountFilled: 1,
			};

			const { processTrade } = CandleProcessor({
				symbols: SYMBOLS,
				isRunning: true,
			});

			await processTrade(deviatedTrade, '1');

			expect(mockPut).toHaveBeenCalledWith({
				record: {
					...deviatedTrade,
					pk: 'FILTERED_TRADE',
				},
			});
			expect(mockUpdateCandleRecord).not.toHaveBeenCalled();
		});
	});
});
