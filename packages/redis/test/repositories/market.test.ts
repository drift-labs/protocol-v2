import { TradeRecord, VolumeInterval } from '@backend/common';
import Decimal from 'decimal.js';
import { MarketCacheRepository } from '../../src/repositories/markets';

const mockExecuteInPipeline = jest.fn();
const mockSAdd = jest.fn();
const mockSMembers = jest.fn();
const mockHGetAll = jest.fn();
const mockHmSet = jest.fn();
const mockPublish = jest.fn();
const mockSet = jest.fn();
const mockGet = jest.fn();

jest.mock('../../src/client', () => ({
	Redis: () => ({
		executeInPipeline: mockExecuteInPipeline,
		sAdd: mockSAdd,
		sMembers: mockSMembers,
		hGetAll: mockHGetAll,
		hmSet: mockHmSet,
		publish: mockPublish,
		set: mockSet,
		get: mockGet,
	}),
}));

describe('MarketCacheRepository', () => {
	let repository: ReturnType<typeof MarketCacheRepository>;

	beforeEach(() => {
		jest.clearAllMocks();
		repository = MarketCacheRepository();
	});

	describe('storeTradeBucket', () => {
		it('should pipeline trade data and update market set', async () => {
			const trade: TradeRecord = {
				symbol: 'SOL-PERP',
				marketIndex: 0,
				marketType: 'perp',
				ts: 1620000007,
				quoteAssetAmountFilled: '1000',
				baseAssetAmountFilled: '0.5',
			} as any;

			await repository.storeTradeBucket(trade);

			expect(mockExecuteInPipeline).toHaveBeenCalledTimes(1);
			expect(mockExecuteInPipeline).toHaveBeenCalledWith(expect.any(Function));

			const pipeline = {
				hIncrByFloat: jest.fn(),
				expire: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.hIncrByFloat).toHaveBeenCalledWith(expect.any(String), 'quote', 1000);
			expect(pipeline.hIncrByFloat).toHaveBeenCalledWith(expect.any(String), 'base', 0.5);
			expect(pipeline.expire).toHaveBeenCalled();
			expect(pipeline.sAdd).toHaveBeenCalledWith(
				expect.any(String),
				JSON.stringify({
					symbol: 'SOL-PERP',
					marketIndex: 0,
					marketType: 'perp',
				})
			);
		});
	});

	describe('getMarkets', () => {
		it('should return parsed market info', async () => {
			mockSMembers.mockResolvedValue([
				JSON.stringify({ symbol: 'SOL-PERP', marketIndex: 0, marketType: 'perp' }),
			]);

			const result = await repository.getMarkets();
			expect(result).toEqual([{ symbol: 'SOL-PERP', marketIndex: 0, marketType: 'perp' }]);
		});
	});

	describe('getBucketDataForTimeRange', () => {
		it('should fetch and filter non-empty buckets', async () => {
			const mockResults = [
				{ quote: 1000, base: 10 },
				{}, // empty bucket
				{ quote: 500, base: 5 },
			];

			mockExecuteInPipeline.mockImplementation((fn) => {
				const calls: any[] = [];
				const fakePipeline = {
					hGetAll: (key: string) => calls.push(key),
				};
				fn(fakePipeline); // simulate the internal call
				expect(calls.length).toBe(3); // 3 buckets between start and end
				return Promise.resolve(mockResults);
			});

			const start = 1752125930;
			const end = start + 20; // implies 3 buckets: 0s, +10s, +20s

			const result = await repository.getBucketDataForTimeRange('BTC-PERP', start, end);

			expect(result).toEqual([
				{ quote: 1000, base: 10 },
				{ quote: 500, base: 5 },
			]);
		});
	});

	describe('calculateRollingVolumes', () => {
		beforeEach(() => {
			const mockMarkets = [
				{ symbol: 'BTC-PERP', marketIndex: 1, marketType: 'perp' },
				{ symbol: 'SOL-PERP', marketIndex: 2, marketType: 'perp' },
			];
			mockSMembers.mockResolvedValue(mockMarkets.map((m) => JSON.stringify(m)));
		});

		it('should calculate 24h volumes from buckets and store results', async () => {
			mockExecuteInPipeline
				.mockResolvedValueOnce([{ quote: 100, base: 10 }]) // BTC
				.mockResolvedValueOnce([{ quote: 50, base: 5 }]); // SOL

			const result = await repository.calculateRollingVolumes(
				VolumeInterval.TWENTY_FOUR_HOUR
			);

			expect(result).toEqual({
				markets: [
					{
						symbol: 'BTC-PERP',
						quoteVolume: new Decimal(100).toFixed(6),
						baseVolume: new Decimal(10).toFixed(6),
						marketIndex: 1,
						marketType: 'perp',
					},
					{
						symbol: 'SOL-PERP',
						quoteVolume: new Decimal(50).toFixed(6),
						baseVolume: new Decimal(5).toFixed(6),
						marketIndex: 2,
						marketType: 'perp',
					},
				],
				total: new Decimal(150).toFixed(6), // 100 + 50
			});

			expect(mockSet).toHaveBeenCalledWith(
				expect.stringMatching(/total:24h$/),
				new Decimal(150).toFixed(6)
			);
		});

		it('should calculate 1h volumes from buckets and store results', async () => {
			mockExecuteInPipeline
				.mockResolvedValueOnce([{ quote: 75, base: 7.5 }]) // BTC
				.mockResolvedValueOnce([{ quote: 25, base: 2.5 }]); // SOL

			const result = await repository.calculateRollingVolumes(VolumeInterval.ONE_HOUR);

			expect(result).toEqual({
				markets: [
					{
						symbol: 'BTC-PERP',
						quoteVolume: new Decimal(75).toFixed(6),
						baseVolume: new Decimal(7.5).toFixed(6),
						marketIndex: 1,
						marketType: 'perp',
					},
					{
						symbol: 'SOL-PERP',
						quoteVolume: new Decimal(25).toFixed(6),
						baseVolume: new Decimal(2.5).toFixed(6),
						marketIndex: 2,
						marketType: 'perp',
					},
				],
				total: new Decimal(100).toFixed(6), // 75 + 25
			});

			expect(mockSet).toHaveBeenCalledWith(
				expect.stringMatching(/total:1h$/),
				new Decimal(100).toFixed(6)
			);
		});

		it('should default to 24h interval when no interval provided', async () => {
			mockExecuteInPipeline
				.mockResolvedValueOnce([{ quote: 100, base: 10 }]) // BTC
				.mockResolvedValueOnce([{ quote: 50, base: 5 }]); // SOL

			const result = await repository.calculateRollingVolumes();

			expect(mockSet).toHaveBeenCalledWith(
				expect.stringMatching(/total:24h$/),
				new Decimal(150).toFixed(6)
			);
		});
	});

	describe('setMarketVolumes', () => {
		it('should call hmSet with serialized volume data and store total for 24h', async () => {
			const volumeData = {
				markets: [
					{
						symbol: 'SOL-PERP',
						quoteVolume: '1000',
						baseVolume: '10',
						marketIndex: 0,
						marketType: 'perp',
					},
				],
				total: '1000.000000',
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			};

			await repository.setMarketVolumes(volumeData);

			expect(mockHmSet).toHaveBeenCalledWith(expect.stringMatching(/24h:aggregates$/), {
				'SOL-PERP': JSON.stringify({
					quoteVolume: '1000',
					baseVolume: '10',
					marketIndex: 0,
					marketType: 'perp',
				}),
			});

			expect(mockSet).toHaveBeenCalledWith(
				expect.stringMatching(/total:24h$/),
				'1000.000000'
			);
		});

		it('should call hmSet with serialized volume data and store total for 1h', async () => {
			const volumeData = {
				markets: [
					{
						symbol: 'SOL-PERP',
						quoteVolume: '500',
						baseVolume: '5',
						marketIndex: 0,
						marketType: 'perp',
					},
				],
				total: '500.000000',
				interval: VolumeInterval.ONE_HOUR,
			};

			await repository.setMarketVolumes(volumeData);

			expect(mockHmSet).toHaveBeenCalledWith(expect.stringMatching(/1h:aggregates$/), {
				'SOL-PERP': JSON.stringify({
					quoteVolume: '500',
					baseVolume: '5',
					marketIndex: 0,
					marketType: 'perp',
				}),
			});

			expect(mockSet).toHaveBeenCalledWith(expect.stringMatching(/total:1h$/), '500.000000');
		});

		it('should return early if no markets provided', async () => {
			await repository.setMarketVolumes({ markets: [], total: '0.000000' });

			expect(mockHmSet).not.toHaveBeenCalled();
			expect(mockSet).not.toHaveBeenCalled();
		});
	});

	describe('getMarketsVolume', () => {
		it('should return null if empty volume data for 24h', async () => {
			mockHGetAll.mockResolvedValue({});
			mockGet.mockResolvedValue('0.000000');

			const result = await repository.getMarketsVolume({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});
			expect(result).toBeNull();
		});

		it('should return null if empty volume data for 1h', async () => {
			mockHGetAll.mockResolvedValue({});
			mockGet.mockResolvedValue('0.000000');

			const result = await repository.getMarketsVolume({
				interval: VolumeInterval.ONE_HOUR,
			});
			expect(result).toBeNull();
		});

		it('should return parsed 24h volume data if available', async () => {
			const stored = {
				'SOL-PERP': JSON.stringify({
					quoteVolume: '1000',
					baseVolume: '10',
					marketIndex: 0,
					marketType: 'perp',
				}),
			};
			mockHGetAll.mockResolvedValue(stored);
			mockGet.mockResolvedValue('1000.000000');

			const result = await repository.getMarketsVolume({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});
			expect(result).toEqual({
				markets: [
					{
						symbol: 'SOL-PERP',
						quoteVolume: '1000',
						baseVolume: '10',
						marketIndex: 0,
						marketType: 'perp',
					},
				],
				total: '1000.000000',
			});

			expect(mockHGetAll).toHaveBeenCalledWith(expect.stringMatching(/24h:aggregates$/));
			expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/total:24h$/));
		});

		it('should return parsed 1h volume data if available', async () => {
			const stored = {
				'BTC-PERP': JSON.stringify({
					quoteVolume: '500',
					baseVolume: '5',
					marketIndex: 1,
					marketType: 'perp',
				}),
			};
			mockHGetAll.mockResolvedValue(stored);
			mockGet.mockResolvedValue('500.000000');

			const result = await repository.getMarketsVolume({
				interval: VolumeInterval.ONE_HOUR,
			});
			expect(result).toEqual({
				markets: [
					{
						symbol: 'BTC-PERP',
						quoteVolume: '500',
						baseVolume: '5',
						marketIndex: 1,
						marketType: 'perp',
					},
				],
				total: '500.000000',
			});

			expect(mockHGetAll).toHaveBeenCalledWith(expect.stringMatching(/1h:aggregates$/));
			expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/total:1h$/));
		});

		it('should handle missing total volume', async () => {
			const stored = {
				'SOL-PERP': JSON.stringify({
					quoteVolume: '1000',
					baseVolume: '10',
					marketIndex: 0,
					marketType: 'perp',
				}),
			};
			mockHGetAll.mockResolvedValue(stored);
			mockGet.mockResolvedValue(null);

			const result = await repository.getMarketsVolume({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});
			expect(result).toEqual({
				markets: [
					{
						symbol: 'SOL-PERP',
						quoteVolume: '1000',
						baseVolume: '10',
						marketIndex: 0,
						marketType: 'perp',
					},
				],
				total: '0.000000',
			});
		});

		it('should default to 24h interval when no interval provided', async () => {
			const stored = {
				'SOL-PERP': JSON.stringify({
					quoteVolume: '1000',
					baseVolume: '10',
					marketIndex: 0,
					marketType: 'perp',
				}),
			};
			mockHGetAll.mockResolvedValue(stored);
			mockGet.mockResolvedValue('1000.000000');

			const result = await repository.getMarketsVolume({
				interval: VolumeInterval.TWENTY_FOUR_HOUR,
			});

			expect(mockHGetAll).toHaveBeenCalledWith(expect.stringMatching(/24h:aggregates$/));
			expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/total:24h$/));
		});
	});

	describe('publishMarketVolumes', () => {
		it('should publish volume data to Redis', async () => {
			const volumeData = {
				markets: [
					{
						symbol: 'SOL-PERP',
						quoteVolume: '1000',
						baseVolume: '10',
						marketIndex: 0,
						marketType: 'perp',
					},
				],
				total: '1000.000000',
			};

			await repository.publishMarketVolumes(volumeData);
			expect(mockPublish).toHaveBeenCalledWith(
				expect.stringMatching(/24h:publish$/),
				JSON.stringify(volumeData)
			);
		});
	});
});
