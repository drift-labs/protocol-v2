// Simple test focusing on pure business logic functions without AWS dependencies

import {
	addMarketSymbolsToStats,
	createDayBatch,
	getAllMarkets,
	shouldStopAfterBatch,
	shouldStopBackfill,
	type BackfillConfig,
	type BackfillResult,
} from '../src/tasks/analytics';

// Mock dependencies using jest.fn() directly to avoid hoisting issues
jest.mock('@backend/common', () => ({
	getPerpMarketSymbol: jest.fn(),
	getSpotMarketSymbol: jest.fn(),
	getTimestamp: jest.fn(),
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
	roundToDay: jest.fn(),
}));

jest.mock('@backend/athena', () => ({
	FillQualityAnalyticsRepository: () => ({ getAuctionLatencyStats: jest.fn() }),
	TriggerOrderAnalyticsRepository: () => ({ getTriggerOrderFillAnalytics: jest.fn() }),
	LiquiditySourceAnalyticsRepository: () => ({ getLiquiditySourceAnalytics: jest.fn() }),
}));

jest.mock('@backend/dynamodb', () => ({
	AnalyticsRepository: () => ({
		createAuctionLatencyStats: jest.fn(),
		getOldestAuctionLatencyStats: jest.fn(),
		createTriggerOrderFillStats: jest.fn(),
		getOldestTriggerOrderFillStats: jest.fn(),
	}),
}));

jest.mock('@velocity-exchange/sdk', () => ({ VelocityClient: jest.fn() }));

jest.mock('bottleneck', () => jest.fn(() => ({ schedule: jest.fn((fn) => fn()) })));

// Mock scheduler
const mockScheduleTask = jest.fn();
const mockScheduler = { scheduleTask: mockScheduleTask } as any;

jest.mock('../src/services/scheduler', () => ({
	Scheduler: jest.fn(() => mockScheduler),
}));

// Get references to the mocked functions after mocks are set up
const { getPerpMarketSymbol, getSpotMarketSymbol, logger: _logger, roundToDay } =
	jest.requireMock('@backend/common');

// Mock VelocityClient
const mockDriftClient = {
	getPerpMarketAccounts: jest.fn(),
	getSpotMarketAccounts: jest.fn(),
} as any;

// Constants for testing
const MIN_BACKFILL_DATE = new Date('2024-01-01').getTime() / 1000;
const OLD_TIMESTAMP = new Date('2024-01-15').getTime() / 1000;
const TOO_OLD_TIMESTAMP = new Date('2023-12-15').getTime() / 1000;

const DEFAULT_CONFIG: BackfillConfig = {
	minDate: MIN_BACKFILL_DATE,
	maxConsecutiveEmptyDays: 7,
	batchSize: 7,
};

describe('Analytics Tasks - Pure Business Logic Tests', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		// Setup market data
		mockDriftClient.getPerpMarketAccounts.mockReturnValue([
			{ marketIndex: 0 },
			{ marketIndex: 1 },
		]);

		mockDriftClient.getSpotMarketAccounts.mockReturnValue([
			{ marketIndex: 0 },
			{ marketIndex: 1 },
		]);

		// Setup symbol mocks
		getPerpMarketSymbol.mockImplementation((index: number) => {
			switch (index) {
				case 0:
					return 'SOL-PERP';
				case 1:
					return 'BTC-PERP';
				default:
					return `PERP-${index}`;
			}
		});

		getSpotMarketSymbol.mockImplementation((index: number) => {
			switch (index) {
				case 0:
					return 'USDC';
				case 1:
					return 'SOL';
				default:
					return `SPOT-${index}`;
			}
		});

		roundToDay.mockImplementation((ts: number) => Math.floor(ts / 86400) * 86400);
	});

	describe('getAllMarkets', () => {
		it('should return all markets excluding betting markets', () => {
			getPerpMarketSymbol.mockImplementation((index: number) =>
				index === 1 ? 'SOL-BET' : 'SOL-PERP'
			);

			const markets = getAllMarkets(mockDriftClient);

			expect(markets).toHaveLength(3); // 1 perp (excluding betting) + 2 spot
			expect(markets.filter((m) => m.isPerp)).toHaveLength(1);
			expect(markets.filter((m) => !m.isPerp)).toHaveLength(2);
			expect(markets.find((m) => m.symbol.includes('-BET'))).toBeUndefined();
		});

		it('should handle empty market lists', () => {
			mockDriftClient.getPerpMarketAccounts.mockReturnValue([]);
			mockDriftClient.getSpotMarketAccounts.mockReturnValue([]);

			const markets = getAllMarkets(mockDriftClient);
			expect(markets).toHaveLength(0);
		});

		it('should correctly identify perp vs spot markets', () => {
			const markets = getAllMarkets(mockDriftClient);

			const perpMarkets = markets.filter((m) => m.isPerp);
			const spotMarkets = markets.filter((m) => !m.isPerp);

			expect(perpMarkets).toHaveLength(2);
			expect(spotMarkets).toHaveLength(2);

			expect(perpMarkets[0].symbol).toBe('SOL-PERP');
			expect(perpMarkets[1].symbol).toBe('BTC-PERP');
			expect(spotMarkets[0].symbol).toBe('USDC');
			expect(spotMarkets[1].symbol).toBe('SOL');
		});
	});

	describe('shouldStopBackfill', () => {
		it('should return true when oldest timestamp is at minimum date', () => {
			expect(shouldStopBackfill(MIN_BACKFILL_DATE, DEFAULT_CONFIG)).toBe(true);
		});

		it('should return true when oldest timestamp is before minimum date', () => {
			expect(shouldStopBackfill(TOO_OLD_TIMESTAMP, DEFAULT_CONFIG)).toBe(true);
		});

		it('should return false when oldest timestamp is after minimum date', () => {
			expect(shouldStopBackfill(OLD_TIMESTAMP, DEFAULT_CONFIG)).toBe(false);
		});

		it('should work with different config minimum dates', () => {
			const customConfig: BackfillConfig = {
				...DEFAULT_CONFIG,
				minDate: new Date('2023-01-01').getTime() / 1000,
			};

			expect(shouldStopBackfill(TOO_OLD_TIMESTAMP, customConfig)).toBe(false);
			expect(shouldStopBackfill(MIN_BACKFILL_DATE, customConfig)).toBe(false);
		});
	});

	describe('createDayBatch', () => {
		it('should create a batch of days within date boundaries', () => {
			const oldestTimestamp = OLD_TIMESTAMP;
			const { batch, shouldContinue } = createDayBatch(oldestTimestamp, DEFAULT_CONFIG);

			expect(batch).toHaveLength(7);
			expect(shouldContinue).toBe(true);
			expect(batch[0].from).toBeDefined();
			expect(batch[0].to).toBeDefined();
			expect(batch[0].dayString).toMatch(/\d{4}-\d{2}-\d{2}/);
		});

		it('should stop batch creation when reaching minimum date', () => {
			const oldestTimestamp = MIN_BACKFILL_DATE + 2 * 24 * 60 * 60;
			const { batch, shouldContinue } = createDayBatch(oldestTimestamp, DEFAULT_CONFIG);

			expect(batch.length).toBeLessThan(DEFAULT_CONFIG.batchSize);
			expect(shouldContinue).toBe(false);
		});

		it('should create proper day strings', () => {
			const oldestTimestamp = OLD_TIMESTAMP;
			const { batch } = createDayBatch(oldestTimestamp, DEFAULT_CONFIG);

			batch.forEach((day) => {
				expect(day.dayString).toMatch(/\d{4}-\d{2}-\d{2}/);
			});
		});

		it('should handle custom batch sizes', () => {
			const customConfig: BackfillConfig = { ...DEFAULT_CONFIG, batchSize: 3 };
			const { batch } = createDayBatch(1800000000, customConfig);
			expect(batch).toHaveLength(3);
		});

		it('should correctly calculate day ranges in reverse chronological order', () => {
			const oldestTimestamp = MIN_BACKFILL_DATE + 30 * 24 * 60 * 60;
			const { batch } = createDayBatch(oldestTimestamp, { ...DEFAULT_CONFIG, batchSize: 2 });

			expect(batch).toHaveLength(2);
			// Days should be in reverse chronological order
			const dayDiff = batch[0].from - batch[1].from;
			expect(dayDiff).toBe(24 * 60 * 60);
		});
	});

	describe('shouldStopAfterBatch', () => {
		it('should return true when no days have data', () => {
			const results: BackfillResult[] = [
				{ from: 1, to: 2, dayString: '2024-01-01', stats: [], hasData: false },
				{ from: 3, to: 4, dayString: '2024-01-02', stats: [], hasData: false },
			];

			expect(shouldStopAfterBatch(results)).toBe(true);
		});

		it('should return false when at least one day has data', () => {
			const results: BackfillResult[] = [
				{ from: 1, to: 2, dayString: '2024-01-01', stats: [], hasData: false },
				{
					from: 3,
					to: 4,
					dayString: '2024-01-02',
					stats: [{ test: 'data' }],
					hasData: true,
				},
			];

			expect(shouldStopAfterBatch(results)).toBe(false);
		});

		it('should return false when all days have data', () => {
			const results: BackfillResult[] = [
				{
					from: 1,
					to: 2,
					dayString: '2024-01-01',
					stats: [{ test: 'data1' }],
					hasData: true,
				},
				{
					from: 3,
					to: 4,
					dayString: '2024-01-02',
					stats: [{ test: 'data2' }],
					hasData: true,
				},
			];

			expect(shouldStopAfterBatch(results)).toBe(false);
		});
	});

	describe('addMarketSymbolsToStats', () => {
		it('should add correct symbols for perp markets', () => {
			const stats = [
				{ marketType: 'perp', marketIndex: '0' },
				{ marketType: 'perp', marketIndex: '1' },
			] as any[];

			addMarketSymbolsToStats(stats);

			expect(stats[0].market).toBe('SOL-PERP');
			expect(stats[1].market).toBe('BTC-PERP');
		});

		it('should add correct symbols for spot markets', () => {
			const stats = [
				{ marketType: 'spot', marketIndex: '0' },
				{ marketType: 'spot', marketIndex: '1' },
			] as any[];

			addMarketSymbolsToStats(stats);

			expect(stats[0].market).toBe('USDC');
			expect(stats[1].market).toBe('SOL');
		});

		it('should handle mixed market types', () => {
			const stats = [
				{ marketType: 'perp', marketIndex: '0' },
				{ marketType: 'spot', marketIndex: '1' },
				{ marketType: 'perp', marketIndex: '1' },
			] as any[];

			addMarketSymbolsToStats(stats);

			expect(stats[0].market).toBe('SOL-PERP');
			expect(stats[1].market).toBe('SOL');
			expect(stats[2].market).toBe('BTC-PERP');
		});

		it('should handle empty stats array', () => {
			const stats: any[] = [];
			expect(() => addMarketSymbolsToStats(stats)).not.toThrow();
			expect(stats).toHaveLength(0);
		});
	});

	describe('integration scenarios', () => {
		it('should handle backfill stopping at minimum date', () => {
			const config: BackfillConfig = {
				minDate: MIN_BACKFILL_DATE,
				maxConsecutiveEmptyDays: 5,
				batchSize: 3,
			};

			expect(shouldStopBackfill(MIN_BACKFILL_DATE - 100, config)).toBe(true);
			expect(shouldStopBackfill(MIN_BACKFILL_DATE, config)).toBe(true);
			expect(shouldStopBackfill(MIN_BACKFILL_DATE + 100, config)).toBe(false);
		});

		it('should handle complete workflow logic flow', () => {
			// Setup markets
			const markets = getAllMarkets(mockDriftClient);
			expect(markets.length).toBeGreaterThan(0);

			// Test batch creation with timestamp far from min date
			const { batch } = createDayBatch(1800000000, DEFAULT_CONFIG);
			expect(batch.length).toBeGreaterThan(0);

			// Test batch result evaluation
			const resultsWithData: BackfillResult[] = [
				{
					from: 1000,
					to: 2000,
					dayString: '2024-01-01',
					stats: [{ market: 'TEST' }],
					hasData: true,
				},
			];
			expect(shouldStopAfterBatch(resultsWithData)).toBe(false);

			const resultsWithoutData: BackfillResult[] = [
				{ from: 1000, to: 2000, dayString: '2024-01-01', stats: [], hasData: false },
			];
			expect(shouldStopAfterBatch(resultsWithoutData)).toBe(true);
		});

		it('should handle error scenarios in backfill workflow', () => {
			// Test market filtering with betting markets
			getPerpMarketSymbol.mockImplementation((index: number) =>
				index === 0 ? 'BTC-BET' : 'SOL-PERP'
			);
			const markets = getAllMarkets(mockDriftClient);
			expect(markets.find((m) => m.symbol.includes('-BET'))).toBeUndefined();

			// Test edge case with very old timestamp
			const veryOldTimestamp = MIN_BACKFILL_DATE - 365 * 24 * 60 * 60;
			expect(shouldStopBackfill(veryOldTimestamp, DEFAULT_CONFIG)).toBe(true);
		});

		it('should handle different configuration scenarios', () => {
			const smallBatchConfig: BackfillConfig = {
				minDate: MIN_BACKFILL_DATE,
				maxConsecutiveEmptyDays: 3,
				batchSize: 2,
			};

			const largeBatchConfig: BackfillConfig = {
				minDate: MIN_BACKFILL_DATE,
				maxConsecutiveEmptyDays: 14,
				batchSize: 14,
			};

			// Test small batch
			const { batch: smallBatch } = createDayBatch(1800000000, smallBatchConfig);
			expect(smallBatch).toHaveLength(2);

			// Test large batch
			const { batch: largeBatch } = createDayBatch(1800000000, largeBatchConfig);
			expect(largeBatch).toHaveLength(14);
		});

		it('should properly validate minimum backfill date enforcement', () => {
			const minDate = new Date('2024-01-01').getTime() / 1000;
			const beforeMinDate = new Date('2023-12-31').getTime() / 1000;
			const atMinDate = minDate;
			const afterMinDate = new Date('2024-01-02').getTime() / 1000;

			expect(shouldStopBackfill(beforeMinDate, DEFAULT_CONFIG)).toBe(true);
			expect(shouldStopBackfill(atMinDate, DEFAULT_CONFIG)).toBe(true);
			expect(shouldStopBackfill(afterMinDate, DEFAULT_CONFIG)).toBe(false);
		});

		it('should handle market symbol generation edge cases', () => {
			// Test with different market indices
			const stats = [
				{ marketType: 'perp', marketIndex: '5' },
				{ marketType: 'spot', marketIndex: '10' },
			] as any[];

			addMarketSymbolsToStats(stats);

			expect(stats[0].market).toBe('PERP-5');
			expect(stats[1].market).toBe('SPOT-10');
		});

		it('should validate batch creation with minimum date boundaries', () => {
			// Test with timestamp exactly at minimum date
			const { batch: exactBatch, shouldContinue: exactContinue } = createDayBatch(
				MIN_BACKFILL_DATE,
				DEFAULT_CONFIG
			);
			expect(exactBatch).toHaveLength(0);
			expect(exactContinue).toBe(false);

			// Test with timestamp just above minimum date
			const justAboveMin = MIN_BACKFILL_DATE + 25 * 60 * 60; // 25 hours above min
			const { batch: aboveBatch, shouldContinue: aboveContinue } = createDayBatch(
				justAboveMin,
				DEFAULT_CONFIG
			);
			expect(aboveBatch.length).toBeGreaterThan(0);
			expect(aboveContinue).toBe(false);
		});
	});

	describe('comprehensive backfill logic validation', () => {
		it('should handle all components of the backfill workflow', () => {
			// 1. Market retrieval and filtering
			getPerpMarketSymbol.mockImplementation((index: number) =>
				index === 0 ? 'SOL-PERP' : index === 1 ? 'BTC-PERP' : `PERP-${index}`
			);
			const markets = getAllMarkets(mockDriftClient);
			expect(markets).toHaveLength(4); // 2 perp + 2 spot

			// 2. Batch creation with proper boundaries
			const oldestTimestamp = MIN_BACKFILL_DATE + 10 * 24 * 60 * 60; // 10 days after min
			const config: BackfillConfig = {
				minDate: MIN_BACKFILL_DATE,
				maxConsecutiveEmptyDays: 5,
				batchSize: 5,
			};
			const { batch, shouldContinue } = createDayBatch(oldestTimestamp, config);

			expect(batch).toHaveLength(5);
			expect(shouldContinue).toBe(true);

			// 3. Symbol assignment
			const testStats = [
				{ marketType: 'perp', marketIndex: '0' },
				{ marketType: 'perp', marketIndex: '1' },
				{ marketType: 'spot', marketIndex: '0' },
				{ marketType: 'spot', marketIndex: '1' },
			] as any[];

			addMarketSymbolsToStats(testStats);

			expect(testStats[0].market).toBe('SOL-PERP');
			expect(testStats[1].market).toBe('BTC-PERP');
			expect(testStats[2].market).toBe('USDC');
			expect(testStats[3].market).toBe('SOL');

			// 4. Stopping conditions
			expect(shouldStopBackfill(MIN_BACKFILL_DATE - 100, config)).toBe(true);
			expect(shouldStopBackfill(oldestTimestamp, config)).toBe(false);

			// 5. Batch result evaluation
			const mixedResults: BackfillResult[] = [
				{ from: 1, to: 2, dayString: '2024-01-01', stats: testStats, hasData: true },
				{ from: 3, to: 4, dayString: '2024-01-02', stats: [], hasData: false },
			];
			expect(shouldStopAfterBatch(mixedResults)).toBe(false);
		});

		it('should validate comprehensive configuration handling', () => {
			const configurations = [
				{ minDate: MIN_BACKFILL_DATE, maxConsecutiveEmptyDays: 1, batchSize: 1 },
				{ minDate: MIN_BACKFILL_DATE, maxConsecutiveEmptyDays: 30, batchSize: 30 },
				{
					minDate: MIN_BACKFILL_DATE - 365 * 24 * 60 * 60,
					maxConsecutiveEmptyDays: 7,
					batchSize: 7,
				},
			];

			configurations.forEach((config, index) => {
				const testTimestamp = MIN_BACKFILL_DATE + 10 * 24 * 60 * 60;
				const { batch } = createDayBatch(testTimestamp, config);

				if (index === 0) {
					expect(batch).toHaveLength(1);
				} else if (index === 1) {
					expect(batch).toHaveLength(10); // Limited by days available above min date
				} else {
					expect(batch).toHaveLength(7);
				}
			});
		});
	});
});
