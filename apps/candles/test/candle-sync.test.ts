import { CandleResolutions, getResolutionSeconds } from '@backend/common';
import { CandleRepository } from '@backend/dynamodb';
import { CandleCacheRepository, Redis } from '@backend/redis';
import { CANDLE_RESOLUTIONS } from '../src/services/candle-processor';
import { CandleSync } from '../src/services/candle-sync';

// Mock dependencies
jest.mock('@backend/dynamodb');
jest.mock('@backend/redis');
jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	logger: {
		info: jest.fn(),
		error: jest.fn(),
	},
	getResolutionSeconds: (resolution: string) => {
		const map: Record<string, number> = {
			'1': 60,
			'5': 300,
			'15': 900,
			'60': 3600,
			'240': 14400,
			D: 86400,
			W: 604800,
			M: 2592000,
		};
		return map[resolution];
	},
}));

// Mock Bottleneck
jest.mock('bottleneck', () => {
	return jest.fn().mockImplementation(() => ({
		schedule: jest.fn().mockImplementation((fn) => fn()),
	}));
});

const SYMBOLS = ['SOL-PERP', 'BTC-PERP'];

describe('CandleSync', () => {
	const mockGetCandles = jest.fn();
	const mockGenerateSetKey = jest.fn();
	const mockGenerateKey = jest.fn();
	const mockMSetWithTTL = jest.fn();

	const mockDate = new Date('2024-01-01T10:00:00Z');
	const mockTimestamp = Math.floor(mockDate.getTime() / 1000);

	beforeEach(() => {
		jest.clearAllMocks();

		(CandleRepository as jest.Mock).mockReturnValue({
			getCandlesBetweenTimestampsForResolution: mockGetCandles,
		});

		(CandleCacheRepository as jest.Mock).mockReturnValue({
			generateCandleKey: mockGenerateKey,
			generateSetKey: mockGenerateSetKey,
		});

		(Redis as jest.Mock).mockReturnValue({
			mSetWithTTL: mockMSetWithTTL,
			zAdd: jest.fn(),
		});

		jest.spyOn(Date, 'now').mockReturnValue(mockDate.getTime());
		mockGenerateKey.mockImplementation(
			(symbol, resolution, ts) => `${symbol}:${resolution}:${ts}`
		);
		mockMSetWithTTL.mockResolvedValue(undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('getSyncCutoffTime', () => {
		test.each([
			['1', 60, 5], // 1-minute resolution uses multiplier of 5
			['5', 300, 1], // All other resolutions use multiplier of 1
			['15', 900, 1],
			['60', 3600, 1],
			['240', 14400, 1],
			['D', 86400, 1],
			['W', 604800, 1],
			['M', 2592000, 1],
		])(
			'should align %s resolution to %d second boundary with multiplier %d',
			(resolution, seconds, multiplier) => {
				const candleSync = CandleSync({ symbols: SYMBOLS });
				const result = candleSync.getSyncCutoffTime(resolution as CandleResolutions);

				// The result should still be aligned to the resolution boundary
				expect(result % seconds).toBe(0);

				// Calculate expected cutoff time with multiplier
				const currentCandleStart = Math.floor(mockTimestamp / seconds) * seconds;
				const expectedCutoff = currentCandleStart - seconds * multiplier;

				expect(result).toBe(expectedCutoff);
			}
		);
	});

	describe('sync', () => {
		const mockCandles = [
			{
				symbol: 'BTC-USD',
				resolution: '1' as CandleResolutions,
				ts: mockTimestamp - 120,
				open: 50000,
				high: 51000,
				low: 49000,
				close: 50500,
				volume: 1.5,
			},
		];

		it('should process all symbol/resolution combinations in parallel', async () => {
			mockGetCandles.mockResolvedValue(mockCandles);
			const candleSync = CandleSync({ symbols: SYMBOLS });

			const result = await candleSync.sync();

			expect(result).toBe(true);
			expect(mockGetCandles).toHaveBeenCalledTimes(
				SYMBOLS.length * CANDLE_RESOLUTIONS.length
			);
		});

		it('should handle mixed success and failures', async () => {
			mockGetCandles
				.mockResolvedValueOnce(mockCandles)
				.mockRejectedValueOnce(new Error('Test error'))
				.mockResolvedValue(mockCandles);

			const candleSync = CandleSync({ symbols: SYMBOLS });
			const result = await candleSync.sync();

			expect(result).toBe(false);
			expect(mockGetCandles).toHaveBeenCalledTimes(
				SYMBOLS.length * CANDLE_RESOLUTIONS.length
			);
		});

		it('should batch write to cache correctly', async () => {
			mockGetCandles.mockResolvedValue(mockCandles);
			const candleSync = CandleSync({ symbols: SYMBOLS });

			await candleSync.sync();

			const expectedKeyValuePairs: Record<string, string> = {};
			mockCandles.forEach((candle) => {
				const key = `${candle.symbol}:${candle.resolution}:${candle.ts}`;
				expectedKeyValuePairs[key] = JSON.stringify(candle);
			});

			expect(mockMSetWithTTL).toHaveBeenCalledWith(expectedKeyValuePairs);
		});

		it('should not write to cache when no records found', async () => {
			mockGetCandles.mockResolvedValue([]);
			const candleSync = CandleSync({ symbols: SYMBOLS });

			await candleSync.sync();

			expect(mockMSetWithTTL).not.toHaveBeenCalled();
		});

		it('should maintain data integrity across parallel operations', async () => {
			const differentCandles = CANDLE_RESOLUTIONS.map((resolution) => ({
				...mockCandles[0],
				resolution,
				ts:
					mockTimestamp -
					(mockTimestamp % getResolutionSeconds(resolution as CandleResolutions)),
			}));

			mockGetCandles.mockImplementation(({ resolution }) =>
				Promise.resolve([differentCandles.find((c) => c.resolution === resolution)])
			);

			const candleSync = CandleSync({ symbols: SYMBOLS });
			await candleSync.sync();

			const mSetCalls = mockMSetWithTTL.mock.calls;
			mSetCalls.forEach((call) => {
				const cacheData = call[0];
				Object.values(cacheData).forEach((candleJson) => {
					const candle = JSON.parse(candleJson as string);
					expect(candle.resolution).toBeDefined();
					expect(CANDLE_RESOLUTIONS).toContain(candle.resolution);
				});
			});
		});

		it('should correctly calculate cutoff times for parallel operations', async () => {
			mockGetCandles.mockResolvedValue(mockCandles);
			const candleSync = CandleSync({ symbols: SYMBOLS });

			await candleSync.sync();

			const calls = mockGetCandles.mock.calls;
			calls.forEach((call) => {
				const { resolution, startTs } = call[0];
				const resolutionSeconds = getResolutionSeconds(resolution as CandleResolutions);
				const multiplier = resolution === '1' ? 5 : 1;

				const currentCandleStart =
					Math.floor(mockTimestamp / resolutionSeconds) * resolutionSeconds;
				const expectedCutoff = currentCandleStart - resolutionSeconds * multiplier;

				expect(startTs).toBe(expectedCutoff);
			});
		});
	});
});
