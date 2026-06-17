import {
	getTimestamp,
	getUTCDayFromTimestamp,
	LeaderboardSort,
	TradeRecord,
} from '@backend/common';
import Decimal from 'decimal.js';
import { LeaderboardCacheRepository } from '../../src/repositories/leaderboard';

const mockExecuteInPipeline = jest.fn();
const mockCopy = jest.fn();
const mockExpire = jest.fn();
const mockHIncrByFloat = jest.fn();
const mockZIncrBy = jest.fn();
const mockSAdd = jest.fn();
const mockSMembers = jest.fn();
const mockZRevRank = jest.fn();
const mockZScore = jest.fn();
const mockZRangeWithScores = jest.fn();
const mockZMScore = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockSetEx = jest.fn();
const mockHGet = jest.fn();
const mockHSet = jest.fn();
const mockZDelta = jest.fn();
const mockDel = jest.fn();
const mockExists = jest.fn();
const mockZUnion = jest.fn();
const mockZUnionStore = jest.fn();

jest.mock('../../src/client', () => ({
	Redis: () => ({
		executeInPipeline: mockExecuteInPipeline,
		copy: mockCopy,
		expire: mockExpire,
		hGet: mockHGet,
		hSet: mockHSet,
		get: mockGet,
		set: mockSet,
		setEx: mockSetEx,
		hIncrByFloat: mockHIncrByFloat,
		zIncrBy: mockZIncrBy,
		sAdd: mockSAdd,
		sMembers: mockSMembers,
		zRevRank: mockZRevRank,
		zScore: mockZScore,
		zRangeWithScores: mockZRangeWithScores,
		zMScore: mockZMScore,
		zDelta: mockZDelta,
		zUnion: mockZUnion,
		zUnionStore: mockZUnionStore,
		del: mockDel,
		exists: mockExists,
	}),
}));

const mockGetAccountInfo = jest.fn();
const mockDecodeUser = jest.fn();
jest.mock('@solana/web3.js', () => {
	const original = jest.requireActual('@solana/web3.js');
	return {
		...original,
		Connection: jest.fn().mockImplementation(() => ({
			getAccountInfo: () => mockGetAccountInfo(),
		})),
	};
});

jest.mock('@velocity-exchange/sdk/lib/node/decode/user', () => ({
	decodeUser: () => mockDecodeUser(),
}));

jest.mock('@backend/common', () => {
	const original = jest.requireActual('@backend/common');
	return {
		...original,
		calculatePnlFromTrade: jest.fn((trade, includeFees, side) => {
			// Mock returns the pnlAmount from trade for simplicity
			if (!trade.taker && side === 'taker') return new Decimal(0);
			if (!trade.maker && side === 'maker') return new Decimal(0);
			return trade.pnlAmount || new Decimal(0);
		}),
	};
});

describe('LeaderboardCacheRepository', () => {
	let repository: ReturnType<typeof LeaderboardCacheRepository>;
	const day = getUTCDayFromTimestamp(getTimestamp());

	beforeEach(() => {
		jest.clearAllMocks();
		repository = LeaderboardCacheRepository();
	});

	describe('updateTradeStats', () => {
		it('should increment volume, pnl, user pnl, and fee stats for a trade', async () => {
			const trade: TradeRecord = {
				taker: 'user1',
				maker: 'user2',
				quoteAssetAmountFilled: '1000',
				ts: getTimestamp(),
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(300),
				takerFee: '5.0',
				makerFee: '-0.5',
			} as any;

			mockHGet.mockResolvedValue('authority123');

			await repository.updateTradeStats(trade);

			expect(mockExecuteInPipeline).toHaveBeenCalledWith(expect.any(Function));

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(10);

			// Authority volume and pnl
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:volume:${day}`,
				1000,
				'authority123'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:market:SOL-PERP:volume:${day}`,
				1000,
				'authority123'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:pnl:${day}`,
				300,
				'authority123'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:market:SOL-PERP:pnl:${day}`,
				300,
				'authority123'
			);

			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:taker:volume:${day}`,
				1000,
				'user1'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				300,
				'user1'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:paid:${day}`,
				5.0,
				'user1'
			);

			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:maker:volume:${day}`,
				1000,
				'user2'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				300,
				'user2'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:rebate:${day}`,
				0.5,
				'user2'
			);

			expect(pipeline.sAdd).toHaveBeenCalledWith('{leaderboard}:markets', 'SOL-PERP');
		});

		it('should handle both taker and maker paying fees', async () => {
			const trade: TradeRecord = {
				taker: 'user1',
				maker: 'user2',
				quoteAssetAmountFilled: '1000',
				ts: getTimestamp(),
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(300),
				takerFee: '5.0',
				makerFee: '2.0',
			} as any;

			mockHGet.mockResolvedValue('authority123');

			await repository.updateTradeStats(trade);

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			// Both should have fee paid
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:paid:${day}`,
				5.0,
				'user1'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:paid:${day}`,
				2.0,
				'user2'
			);
		});

		it('should handle both taker and maker receiving rebates', async () => {
			const trade: TradeRecord = {
				taker: 'user1',
				maker: 'user2',
				quoteAssetAmountFilled: '1000',
				ts: getTimestamp(),
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(300),
				takerFee: '-3.0',
				makerFee: '-1.5',
			} as any;

			mockHGet.mockResolvedValue('authority123');

			await repository.updateTradeStats(trade);

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			// Both should have fee rebate
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:rebate:${day}`,
				3.0,
				'user1'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:rebate:${day}`,
				1.5,
				'user2'
			);
		});

		it('should skip fees when they are zero', async () => {
			const trade: TradeRecord = {
				taker: 'user1',
				maker: 'user2',
				quoteAssetAmountFilled: '1000',
				ts: getTimestamp(),
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(300),
				takerFee: '0',
				makerFee: '0',
			} as any;

			mockHGet.mockResolvedValue('authority123');

			await repository.updateTradeStats(trade);

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(8);
		});

		it('should increment pnl stats for negative pnl trades', async () => {
			const trade: TradeRecord = {
				taker: 'user1',
				maker: 'user2',
				quoteAssetAmountFilled: '1000',
				ts: getTimestamp(),
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(-500),
				takerFee: '5.0',
				makerFee: '0',
			} as any;

			mockHGet.mockResolvedValue('authority123');

			await repository.updateTradeStats(trade);

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:pnl:${day}`,
				-500,
				'authority123'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				-500,
				'user1'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				-500,
				'user2'
			);
		});

		it('should skip update if no taker', async () => {
			const trade = {
				taker: undefined,
				maker: '123',
				quoteAssetAmountFilled: '1000',
				symbol: 'SOL-PERP',
				ts: getTimestamp(),
				pnlAmount: new Decimal(300),
				makerFee: '-0.5',
			} as any;
			await repository.updateTradeStats(trade);
			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(3);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:maker:volume:${day}`,
				1000,
				'123'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				300,
				'123'
			);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:fees:rebate:${day}`,
				0.5,
				'123'
			);
		});

		it('should skip maker user pnl update if no maker', async () => {
			const trade = {
				taker: 'user1',
				maker: undefined,
				quoteAssetAmountFilled: '1000',
				symbol: 'SOL-PERP',
				ts: getTimestamp(),
				pnlAmount: new Decimal(300),
				takerFee: '5.0',
			} as any;

			mockHGet.mockResolvedValue('authority123');

			await repository.updateTradeStats(trade);
			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(7);

			expect(pipeline.zIncrBy).toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				300,
				'user1'
			);

			expect(pipeline.zIncrBy).not.toHaveBeenCalledWith(
				`{leaderboard}:user:pnl:${day}`,
				300,
				undefined
			);
		});
	});

	describe('getMarkets', () => {
		it('should return markets list', async () => {
			mockSMembers.mockResolvedValue(['SOL-PERP', 'BTC-PERP']);
			const result = await repository.getMarkets();
			expect(result).toEqual(['SOL-PERP', 'BTC-PERP']);
			expect(mockSMembers).toHaveBeenCalledWith('{leaderboard}:markets');
		});

		it('should return empty array when no markets exist', async () => {
			mockSMembers.mockResolvedValue([]);
			const result = await repository.getMarkets();
			expect(result).toEqual([]);
		});
	});

	describe('getLeaderboard', () => {
		it('should use today keys when start date and end date is today', async () => {
			const volumeKey = `{leaderboard}:volume:${day}`;
			const pnlKey = `{leaderboard}:pnl:${day}`;

			const startVolumeEntries = [
				{ value: 'user1', score: 1000 },
				{ value: 'user2', score: 500 },
			];
			const startPnlEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 50 },
			];

			mockZRangeWithScores.mockImplementation((key) => {
				if (key === volumeKey) return Promise.resolve(startVolumeEntries);
				if (key === pnlKey) return Promise.resolve(startPnlEntries);
				return Promise.resolve([]);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: day,
				end: day,
			});

			expect(mockZRangeWithScores).toHaveBeenCalledTimes(2);
			expect(mockZRangeWithScores).toHaveBeenCalledWith(`{leaderboard}:volume:${day}`, 0, -1);
			expect(mockZRangeWithScores).toHaveBeenCalledWith(`{leaderboard}:pnl:${day}`, 0, -1);

			expect(result).toEqual([
				{ authority: 'user1', volume: 1000, pnl: 100, rank: 1 },
				{ authority: 'user2', volume: 500, pnl: 50, rank: 2 },
			]);
		});

		it('should return leaderboard when using already verified days', async () => {
			const deltaVolumeEntries = [
				{ value: 'user1', score: 1000 },
				{ value: 'user2', score: 500 },
			];
			const deltaPnlEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 50 },
			];

			mockGet.mockResolvedValue('2025-07-07');

			mockZUnion.mockImplementation((key) => {
				if (
					key[0] == '{leaderboard}:volume:verified:2025-07-07' &&
					key[1] == '{leaderboard}:volume:verified:2025-06-30'
				)
					return Promise.resolve(deltaVolumeEntries);
				if (
					key[0] == '{leaderboard}:pnl:verified:2025-07-07' &&
					key[1] == '{leaderboard}:pnl:verified:2025-06-30'
				)
					return Promise.resolve(deltaPnlEntries);
				return Promise.resolve([]);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: '2025-07-01',
				end: '2025-07-07',
			});

			expect(mockZUnion).toHaveBeenCalledTimes(2);

			expect(result).toEqual([
				{ authority: 'user1', volume: 1000, pnl: 100, rank: 1 },
				{ authority: 'user2', volume: 500, pnl: 50, rank: 2 },
			]);
		});

		it('should return leaderboard when using verified and unverified days', async () => {
			mockGet.mockResolvedValue('2025-07-06');

			await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: '2025-07-01',
				end: '2025-07-07',
			});

			expect(mockZUnion).toHaveBeenCalledTimes(2);
			expect(mockZUnionStore).toHaveBeenCalledTimes(2);

			expect(mockZUnionStore).toHaveBeenNthCalledWith(
				1,
				expect.stringMatching(/temp:.*end_volume/),
				['{leaderboard}:volume:verified:2025-07-06', '{leaderboard}:volume:2025-07-07'],
				{ WEIGHTS: [1, 1] }
			);

			expect(mockZUnionStore).toHaveBeenNthCalledWith(
				2,
				expect.stringMatching(/temp:.*end_pnl/),
				['{leaderboard}:pnl:verified:2025-07-06', '{leaderboard}:pnl:2025-07-07'],
				{ WEIGHTS: [1, 1] }
			);

			expect(mockZUnion).toHaveBeenNthCalledWith(
				1,
				[
					expect.stringMatching(/temp:.*end_volume/),
					'{leaderboard}:volume:verified:2025-06-30',
				],
				{ WEIGHTS: [1, -1] }
			);

			expect(mockZUnion).toHaveBeenNthCalledWith(
				2,
				[expect.stringMatching(/temp:.*end_pnl/), '{leaderboard}:pnl:verified:2025-06-30'],
				{ WEIGHTS: [1, -1] }
			);
		});

		it('should return leaderboard entries sorted by pnl', async () => {
			const startVolumeEntries = [
				{ value: 'user1', score: 1000 },
				{ value: 'user2', score: 1500 },
			];
			const startPnlEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 50 },
			];

			mockZRangeWithScores.mockImplementation((key) => {
				if (key === `{leaderboard}:volume:${day}`)
					return Promise.resolve(startVolumeEntries);
				if (key === `{leaderboard}:pnl:${day}`) return Promise.resolve(startPnlEntries);
				return Promise.resolve([]);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: day,
				end: day,
			});

			expect(result).toEqual([
				{ authority: 'user1', volume: 1000, pnl: 100, rank: 1 },
				{ authority: 'user2', volume: 1500, pnl: 50, rank: 2 },
			]);
		});

		it('should return leaderboard entries sorted by volume', async () => {
			const startVolumeEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 500 },
			];
			const startPnlEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 50 },
			];

			mockZRangeWithScores.mockImplementation((key) => {
				if (key === `{leaderboard}:volume:${day}`)
					return Promise.resolve(startVolumeEntries);
				if (key === `{leaderboard}:pnl:${day}`) return Promise.resolve(startPnlEntries);
				return Promise.resolve([]);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.VOLUME,
				page: 1,
				limit: 10,
				start: day,
				end: day,
			});

			expect(result).toEqual([
				{ authority: 'user2', volume: 500, pnl: 50, rank: 1 },
				{ authority: 'user1', volume: 100, pnl: 100, rank: 2 },
			]);
		});

		it('should handle pagination correctly', async () => {
			const users = Array.from({ length: 20 }, (_, i) => ({
				value: `user${i + 1}`,
				score: 1000 - i * 10,
			}));

			mockZRangeWithScores.mockImplementation((key) => {
				if (key === `{leaderboard}:volume:${day}` || key === `{leaderboard}:pnl:${day}`)
					return Promise.resolve(users);
				return Promise.resolve([]);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 2,
				limit: 5,
				start: day,
				end: day,
			});

			expect(result).toHaveLength(5);
			expect(result[0].rank).toBe(6);
			expect(result[4].rank).toBe(10);
		});

		it('should handle tied ranks correctly', async () => {
			const startPnlEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 100 },
				{ value: 'user3', score: 200 },
			];
			mockZRangeWithScores.mockImplementation((key) => {
				if (key === `{leaderboard}:pnl:${day}`) return Promise.resolve(startPnlEntries);
				return Promise.resolve([]);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: day,
				end: day,
			});

			expect(result).toEqual([
				{ authority: 'user3', volume: 0, pnl: 200, rank: 1 },
				{ authority: 'user1', volume: 0, pnl: 100, rank: 2 },
				{ authority: 'user2', volume: 0, pnl: 100, rank: 2 },
			]);
		});

		it('should handle Redis errors gracefully', async () => {
			mockZRangeWithScores.mockRejectedValueOnce(new Error('Redis error'));
			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
			});

			expect(result).toEqual([]);
			mockZRangeWithScores.mockReset();
		});

		it('should use cached deltas when available', async () => {
			const volumeKey = `{leaderboard}:volume:${day}`;
			const pnlKey = `{leaderboard}:pnl:${day}`;

			const startVolumeEntries = [
				{ value: 'user1', score: 1000 },
				{ value: 'user2', score: 500 },
			];
			const startPnlEntries = [
				{ value: 'user1', score: 100 },
				{ value: 'user2', score: 50 },
			];

			// First call: no cache, should hit Redis and then setEx
			mockGet.mockResolvedValueOnce(null); // cache miss for deltas
			mockGet.mockResolvedValueOnce(null); // lastVerifiedDay
			mockZRangeWithScores.mockImplementation((key) => {
				if (key === volumeKey) return Promise.resolve(startVolumeEntries);
				if (key === pnlKey) return Promise.resolve(startPnlEntries);
				return Promise.resolve([]);
			});

			await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: day,
				end: day,
			});

			expect(mockZRangeWithScores).toHaveBeenCalledTimes(2);
			expect(mockSetEx).toHaveBeenCalledTimes(1);

			// Reset mocks for second call
			mockZRangeWithScores.mockClear();
			mockSetEx.mockClear();

			const cachedDeltas = [
				{ authority: 'user1', volume: 1000, pnl: 100 },
				{ authority: 'user2', volume: 500, pnl: 50 },
			];

			// Second call: simulate cache hit for deltas; lastVerifiedDay can be anything or null
			mockGet.mockImplementation((key: string) => {
				if (key.startsWith('{leaderboard}:deltas:')) {
					return Promise.resolve(JSON.stringify(cachedDeltas));
				}
				if (key === '{leaderboard}:last_verified_ts') {
					return Promise.resolve(null);
				}
				return Promise.resolve(null);
			});

			const result = await repository.getLeaderboard({
				sort: LeaderboardSort.PNL,
				page: 1,
				limit: 10,
				start: day,
				end: day,
			});

			expect(result).toEqual([
				{ authority: 'user1', volume: 1000, pnl: 100, rank: 1 },
				{ authority: 'user2', volume: 500, pnl: 50, rank: 2 },
			]);

			expect(mockZRangeWithScores).not.toHaveBeenCalled();
			expect(mockSetEx).not.toHaveBeenCalled();
		});
	});

	describe('getAuthorityForUser', () => {
		const mockTaker = '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S';
		const mockAuthority = 'authority123';

		it('should return authority from cache if exists', async () => {
			mockHGet.mockResolvedValue(mockAuthority);

			const result = await repository.getAuthorityForUser(mockTaker);

			expect(result).toBe(mockAuthority);
			expect(mockHGet).toHaveBeenCalledWith('{leaderboard}:authorities', mockTaker);
			expect(mockGetAccountInfo).not.toHaveBeenCalled();
		});

		it('should fetch authority from blockchain and cache it if not in cache', async () => {
			mockHGet.mockResolvedValue(null);
			mockGetAccountInfo.mockResolvedValue({
				data: Buffer.from('mock-account-data'),
			});
			mockDecodeUser.mockReturnValue({
				authority: {
					toString: () => mockAuthority,
				},
			});

			const result = await repository.getAuthorityForUser(mockTaker);

			expect(result).toBe(mockAuthority);
			expect(mockHGet).toHaveBeenCalledWith('{leaderboard}:authorities', mockTaker);
			expect(mockGetAccountInfo).toHaveBeenCalled();
			expect(mockDecodeUser).toHaveBeenCalled();
			expect(mockHSet).toHaveBeenCalledWith(
				'{leaderboard}:authorities',
				mockTaker,
				mockAuthority
			);
		});

		it('should return null if account info is not found', async () => {
			mockHGet.mockResolvedValue(null);
			mockGetAccountInfo.mockResolvedValue(null);

			const result = await repository.getAuthorityForUser(mockTaker);

			expect(result).toBeNull();
			expect(mockGetAccountInfo).toHaveBeenCalled();
			expect(mockDecodeUser).not.toHaveBeenCalled();
			expect(mockHSet).not.toHaveBeenCalled();
		});

		it('should handle errors gracefully and return null', async () => {
			mockHGet.mockResolvedValue(null);
			mockGetAccountInfo.mockRejectedValue(new Error('Network error'));

			const result = await repository.getAuthorityForUser(mockTaker);

			expect(result).toBeNull();
			expect(mockGetAccountInfo).toHaveBeenCalled();
			expect(mockDecodeUser).not.toHaveBeenCalled();
			expect(mockHSet).not.toHaveBeenCalled();
		});
	});

	describe('getLastVerifiedDay and setLastVerifiedDay', () => {
		it('should get last verified timestamp', async () => {
			const mockTs = '1752454514';
			mockGet.mockResolvedValue(mockTs);

			const result = await repository.getLastVerifiedDay();

			expect(result).toBe(mockTs);
			expect(mockGet).toHaveBeenCalledWith('{leaderboard}:last_verified_ts');
		});

		it('should set last verified timestamp', async () => {
			const mockTs = '1752454514';

			await repository.setLastVerifiedDay(mockTs);

			expect(mockSet).toHaveBeenCalledWith('{leaderboard}:last_verified_ts', mockTs);
		});

		it('should return null when no last verified timestamp exists', async () => {
			mockGet.mockResolvedValue(null);

			const result = await repository.getLastVerifiedDay();

			expect(result).toBeNull();
		});
	});

	describe('verifyLeaderboardType', () => {
		const mockTrades: TradeRecord[] = [
			{
				taker: 'taker1',
				maker: 'maker1',
				quoteAssetAmountFilled: '1000',
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(100),
				takerFee: '5.0',
				makerFee: '-0.5',
			} as any,
			{
				taker: 'taker2',
				maker: 'maker2',
				quoteAssetAmountFilled: '2000',
				symbol: 'SOL-PERP',
				pnlAmount: new Decimal(200),
				takerFee: '10.0',
				makerFee: '2.0',
			} as any,
		];

		beforeEach(() => {
			jest.clearAllMocks();
			mockHGet.mockImplementation((hash, taker) => {
				if (taker === 'taker1') return Promise.resolve('authority1');
				if (taker === 'taker2') return Promise.resolve('authority2');
				return Promise.resolve(null);
			});
		});

		it('verifies volume and only updates authority', async () => {
			const params = {
				currentVerifiedKey: 'current:volume',
				previousVerifiedKey: 'previous:volume',
				trades: mockTrades,
				type: 'volume' as const,
			};

			mockZRangeWithScores.mockResolvedValue([
				{ value: 'authority1', score: 1000 },
				{ value: 'authority2', score: 2000 },
			]);

			await repository.verifyLeaderboardType(params);

			const delta = `current:volume:delta:${getTimestamp()}`;

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn,
			};

			expect(mockCopy).toHaveBeenCalledWith('previous:volume', 'current:volume');
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(2);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:volume`, 1000, 'authority1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:volume`, 2000, 'authority2');
			expect(mockZDelta).toHaveBeenCalledWith(delta, ['previous:volume', 'current:volume']);
			expect(mockDel).toHaveBeenCalledWith(delta);
		});

		it('verifies pnl and only updates authority', async () => {
			const params = {
				currentVerifiedKey: 'current:pnl',
				previousVerifiedKey: 'previous:pnl',
				trades: mockTrades,
				type: 'pnl' as const,
			};

			mockZRangeWithScores.mockResolvedValue([
				{ value: 'authority1', score: 100 },
				{ value: 'authority2', score: 200 },
			]);

			await repository.verifyLeaderboardType(params);

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			const delta = `current:pnl:delta:${getTimestamp()}`;

			expect(mockCopy).toHaveBeenCalledWith('previous:pnl', 'current:pnl');
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(2);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:pnl`, 100, 'authority1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:pnl`, 200, 'authority2');
			expect(mockZDelta).toHaveBeenCalledWith(delta, ['previous:pnl', 'current:pnl']);
			expect(mockDel).toHaveBeenCalledWith(delta);
		});

		it('verifies userPnl and updates both taker and maker', async () => {
			const params = {
				currentVerifiedKey: 'current:userPnl',
				previousVerifiedKey: 'previous:userPnl',
				trades: mockTrades,
				type: 'userPnl' as const,
			};

			mockZRangeWithScores.mockResolvedValue([
				{ value: 'taker1', score: 100 },
				{ value: 'maker1', score: 100 },
				{ value: 'taker2', score: 200 },
				{ value: 'maker2', score: 200 },
			]);

			await repository.verifyLeaderboardType(params);

			const pipeline = {
				zIncrBy: jest.fn(),
				sAdd: jest.fn(),
			};

			expect(mockCopy).toHaveBeenCalledWith('previous:userPnl', 'current:userPnl');
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(4);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:userPnl`, 100, 'taker1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:userPnl`, 100, 'maker1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:userPnl`, 200, 'taker2');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:userPnl`, 200, 'maker2');
		});

		it('verifies feePaid and updates taker and maker with positive fees', async () => {
			const params = {
				currentVerifiedKey: 'current:fees:paid',
				previousVerifiedKey: 'previous:fees:paid',
				trades: mockTrades,
				type: 'feePaid' as const,
			};

			mockZRangeWithScores.mockResolvedValue([
				{ value: 'taker1', score: 5.0 },
				{ value: 'taker2', score: 10.0 },
				{ value: 'maker2', score: 2.0 },
			]);

			await repository.verifyLeaderboardType(params);

			const pipeline = { zIncrBy: jest.fn(), sAdd: jest.fn() };

			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(3);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:fees:paid`, 5, 'taker1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:fees:paid`, 10, 'taker2');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:fees:paid`, 2, 'maker2');
		});

		it('verifies feeRebate and updates taker and maker with negative fees', async () => {
			const params = {
				currentVerifiedKey: 'current:fees:rebate',
				previousVerifiedKey: 'previous:fees:rebate',
				trades: mockTrades,
				type: 'feeRebate' as const,
			};

			mockZRangeWithScores.mockResolvedValue([{ value: 'maker1', score: 0.5 }]);

			await repository.verifyLeaderboardType(params);

			expect(mockExecuteInPipeline).toHaveBeenCalled();

			const pipeline = { zIncrBy: jest.fn(), sAdd: jest.fn() };

			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(1);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:fees:rebate`, 0.5, 'maker1');
		});

		it('verifies makerVolume and only updates maker', async () => {
			const params = {
				currentVerifiedKey: 'current:makerVolume',
				previousVerifiedKey: 'previous:makerVolume',
				trades: mockTrades,
				type: 'makerVolume' as const,
			};

			mockZRangeWithScores.mockResolvedValue([
				{ value: 'maker1', score: 1000 },
				{ value: 'maker2', score: 2000 },
			]);

			await repository.verifyLeaderboardType(params);

			const pipeline = { zIncrBy: jest.fn(), sAdd: jest.fn() };

			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(2);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:makerVolume`, 1000, 'maker1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:makerVolume`, 2000, 'maker2');
		});

		it('verifies takerVolume and only updates taker', async () => {
			const params = {
				currentVerifiedKey: 'current:takerVolume',
				previousVerifiedKey: 'previous:takerVolume',
				trades: mockTrades,
				type: 'takerVolume' as const,
			};

			mockZRangeWithScores.mockResolvedValue([
				{ value: 'taker1', score: 1000 },
				{ value: 'taker2', score: 2000 },
			]);

			await repository.verifyLeaderboardType(params);

			const pipeline = { zIncrBy: jest.fn(), sAdd: jest.fn() };

			mockExecuteInPipeline.mock.calls[0][0](pipeline);
			expect(mockExecuteInPipeline).toHaveBeenCalled();
			expect(pipeline.zIncrBy).toHaveBeenCalledTimes(2);
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:takerVolume`, 1000, 'taker1');
			expect(pipeline.zIncrBy).toHaveBeenCalledWith(`current:takerVolume`, 2000, 'taker2');
		});

		it('handles trades with no fees', async () => {
			const tradesNoFees: TradeRecord[] = [
				{
					taker: 'taker1',
					maker: 'maker1',
					quoteAssetAmountFilled: '1000',
					symbol: 'SOL-PERP',
					pnlAmount: new Decimal(100),
					takerFee: '0',
					makerFee: '0',
				} as any,
			];

			const params = {
				currentVerifiedKey: 'current:fees:paid',
				previousVerifiedKey: 'previous:fees:paid',
				trades: tradesNoFees,
				type: 'feePaid' as const,
			};

			mockZRangeWithScores.mockResolvedValue([]);

			await repository.verifyLeaderboardType(params);

			expect(mockExecuteInPipeline).not.toHaveBeenCalled();
			expect(mockCopy).toHaveBeenCalled();
		});
	});

	describe('getAllUserVolumesAndFees', () => {
		const lastVerifiedDay = '2025-10-17';

		beforeEach(() => {
			jest.spyOn(require('@backend/common'), 'getUTCDayFromTimestamp').mockReturnValue(
				'2025-10-20'
			);
		});

		it('returns maker, taker, userPnl, feePaid, and feeRebate maps using verified + unverified days', async () => {
			mockGet.mockResolvedValue(lastVerifiedDay);

			const makerEntries = [
				{ value: 'm1', score: 8000 },
				{ value: 'm2', score: 4500 },
			];
			const takerEntries = [
				{ value: 't1', score: 5000 },
				{ value: 't2', score: 3000 },
				{ value: 't3', score: 1500 },
			];
			const userPnlEntries = [
				{ value: 'm1', score: 100 },
				{ value: 't1', score: 50 },
			];
			const feePaidEntries = [
				{ value: 'm1', score: 100 },
				{ value: 't1', score: 50 },
			];
			const feeRebateEntries = [
				{ value: 'm2', score: 10 },
				{ value: 't2', score: 5 },
			];

			mockZUnion
				.mockResolvedValueOnce(makerEntries)
				.mockResolvedValueOnce(takerEntries)
				.mockResolvedValueOnce(userPnlEntries)
				.mockResolvedValueOnce(feePaidEntries)
				.mockResolvedValueOnce(feeRebateEntries);

			const result = await repository.getAllUserVolumesAndFees();

			expect(mockGet).toHaveBeenCalledWith('{leaderboard}:last_verified_ts');

			// Verify maker volume union
			expect(mockZUnion).toHaveBeenNthCalledWith(
				1,
				[
					'{leaderboard}:maker:volume:verified:2025-10-17',
					'{leaderboard}:maker:volume:2025-10-18',
					'{leaderboard}:maker:volume:2025-10-19',
					'{leaderboard}:maker:volume:2025-10-20',
				],
				{ WEIGHTS: [1, 1, 1, 1] }
			);

			// Verify taker volume union
			expect(mockZUnion).toHaveBeenNthCalledWith(
				2,
				[
					'{leaderboard}:taker:volume:verified:2025-10-17',
					'{leaderboard}:taker:volume:2025-10-18',
					'{leaderboard}:taker:volume:2025-10-19',
					'{leaderboard}:taker:volume:2025-10-20',
				],
				{ WEIGHTS: [1, 1, 1, 1] }
			);

			// Verify user pnl union
			expect(mockZUnion).toHaveBeenNthCalledWith(
				3,
				[
					'{leaderboard}:user:pnl:verified:2025-10-17',
					'{leaderboard}:user:pnl:2025-10-18',
					'{leaderboard}:user:pnl:2025-10-19',
					'{leaderboard}:user:pnl:2025-10-20',
				],
				{ WEIGHTS: [1, 1, 1, 1] }
			);

			// Verify fee paid union
			expect(mockZUnion).toHaveBeenNthCalledWith(
				4,
				[
					'{leaderboard}:fees:paid:verified:2025-10-17',
					'{leaderboard}:fees:paid:2025-10-18',
					'{leaderboard}:fees:paid:2025-10-19',
					'{leaderboard}:fees:paid:2025-10-20',
				],
				{ WEIGHTS: [1, 1, 1, 1] }
			);

			// Verify fee rebate union
			expect(mockZUnion).toHaveBeenNthCalledWith(
				5,
				[
					'{leaderboard}:fees:rebate:verified:2025-10-17',
					'{leaderboard}:fees:rebate:2025-10-18',
					'{leaderboard}:fees:rebate:2025-10-19',
					'{leaderboard}:fees:rebate:2025-10-20',
				],
				{ WEIGHTS: [1, 1, 1, 1] }
			);

			expect(result.cumulativeMakerVolumes).toBeInstanceOf(Map);
			expect(result.cumulativeTakerVolumes).toBeInstanceOf(Map);
			expect(result.cumulativeRealizedPnl).toBeInstanceOf(Map);
			expect(result.cumulativeFeesPaid).toBeInstanceOf(Map);
			expect(result.cumulativeFeesRebate).toBeInstanceOf(Map);

			expect(result.cumulativeMakerVolumes.size).toBe(2);
			expect(result.cumulativeMakerVolumes.get('m1')).toBe(8000);
			expect(result.cumulativeMakerVolumes.get('m2')).toBe(4500);

			expect(result.cumulativeTakerVolumes.size).toBe(3);
			expect(result.cumulativeTakerVolumes.get('t1')).toBe(5000);
			expect(result.cumulativeTakerVolumes.get('t2')).toBe(3000);
			expect(result.cumulativeTakerVolumes.get('t3')).toBe(1500);

			expect(result.cumulativeRealizedPnl.size).toBe(2);
			expect(result.cumulativeRealizedPnl.get('m1')).toBe(100);
			expect(result.cumulativeRealizedPnl.get('t1')).toBe(50);

			expect(result.cumulativeFeesPaid.size).toBe(2);
			expect(result.cumulativeFeesPaid.get('m1')).toBe(100);
			expect(result.cumulativeFeesPaid.get('t1')).toBe(50);

			expect(result.cumulativeFeesRebate.size).toBe(2);
			expect(result.cumulativeFeesRebate.get('m2')).toBe(10);
			expect(result.cumulativeFeesRebate.get('t2')).toBe(5);
		});

		it('falls back to today-only keys when no last verified day', async () => {
			mockGet.mockResolvedValue(null);

			const todayMaker = [
				{ value: 'm1', score: 100 },
				{ value: 'm2', score: 200 },
			];
			const todayTaker = [
				{ value: 't1', score: 300 },
				{ value: 't2', score: 400 },
			];
			const todayUserPnl = [
				{ value: 'm1', score: 50 },
				{ value: 't1', score: 25 },
			];
			const todayFeePaid = [{ value: 't1', score: 10 }];
			const todayFeeRebate = [{ value: 'm1', score: 5 }];

			mockZRangeWithScores.mockImplementation((key: string) => {
				if (key === '{leaderboard}:maker:volume:2025-10-20')
					return Promise.resolve(todayMaker);
				if (key === '{leaderboard}:taker:volume:2025-10-20')
					return Promise.resolve(todayTaker);
				if (key === '{leaderboard}:user:pnl:2025-10-20')
					return Promise.resolve(todayUserPnl);
				if (key === '{leaderboard}:fees:paid:2025-10-20')
					return Promise.resolve(todayFeePaid);
				if (key === '{leaderboard}:fees:rebate:2025-10-20')
					return Promise.resolve(todayFeeRebate);
				return Promise.resolve([]);
			});

			const result = await repository.getAllUserVolumesAndFees();

			expect(mockZRangeWithScores).toHaveBeenCalledWith(
				'{leaderboard}:maker:volume:2025-10-20',
				0,
				-1
			);
			expect(mockZRangeWithScores).toHaveBeenCalledWith(
				'{leaderboard}:taker:volume:2025-10-20',
				0,
				-1
			);
			expect(mockZRangeWithScores).toHaveBeenCalledWith(
				'{leaderboard}:user:pnl:2025-10-20',
				0,
				-1
			);
			expect(mockZRangeWithScores).toHaveBeenCalledWith(
				'{leaderboard}:fees:paid:2025-10-20',
				0,
				-1
			);
			expect(mockZRangeWithScores).toHaveBeenCalledWith(
				'{leaderboard}:fees:rebate:2025-10-20',
				0,
				-1
			);

			expect(result.cumulativeMakerVolumes.get('m1')).toBe(100);
			expect(result.cumulativeMakerVolumes.get('m2')).toBe(200);
			expect(result.cumulativeTakerVolumes.get('t1')).toBe(300);
			expect(result.cumulativeTakerVolumes.get('t2')).toBe(400);
			expect(result.cumulativeRealizedPnl.get('m1')).toBe(50);
			expect(result.cumulativeRealizedPnl.get('t1')).toBe(25);
			expect(result.cumulativeFeesPaid.get('t1')).toBe(10);
			expect(result.cumulativeFeesRebate.get('m1')).toBe(5);
		});

		it('returns empty maps when nothing in today and no verified day', async () => {
			mockGet.mockResolvedValue(null);
			mockZRangeWithScores.mockResolvedValue([]);

			const result = await repository.getAllUserVolumesAndFees();

			expect(result.cumulativeMakerVolumes.size).toBe(0);
			expect(result.cumulativeTakerVolumes.size).toBe(0);
			expect(result.cumulativeRealizedPnl.size).toBe(0);
			expect(result.cumulativeFeesPaid.size).toBe(0);
			expect(result.cumulativeFeesRebate.size).toBe(0);
		});
	});

	describe('getUserVolumeAndFees', () => {
		beforeEach(() => {
			jest.spyOn(require('@backend/common'), 'getUTCDayFromTimestamp').mockReturnValue(
				'2025-10-20'
			);
		});

		it('get volume, userPnl and fees across verified + unverified days', async () => {
			const user = 'user123';
			mockGet.mockResolvedValue('2025-10-17');

			// Pipeline return values:
			// 4 maker volumes: 10 + 20 + 0 + 5 = 35
			// 4 taker volumes: 0 + 7 + 8 + 0 = 15
			// 4 user pnl: 5 + 10 + 0 + 2 = 17
			// 4 fees paid: 1 + 2 + 0 + 0.5 = 3.5
			// 4 fees rebate: 0 + 0.1 + 0.3 + 0 = 0.4
			mockExecuteInPipeline.mockResolvedValueOnce([
				10,
				20,
				null,
				5, // maker volumes
				null,
				7,
				8,
				0, // taker volumes
				5,
				10,
				null,
				2, // user pnl
				1,
				2,
				null,
				0.5, // fees paid
				null,
				0.1,
				0.3,
				null, // fees rebate
			] as any);

			const result = await repository.getUserVolumeAndFees({ user });

			const pipeline = { zScore: jest.fn() };
			mockExecuteInPipeline.mock.calls[0][0](pipeline);

			expect(pipeline.zScore).toHaveBeenCalledTimes(20);

			// Maker volume calls
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				1,
				'{leaderboard}:maker:volume:verified:2025-10-17',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				2,
				'{leaderboard}:maker:volume:2025-10-18',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				3,
				'{leaderboard}:maker:volume:2025-10-19',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				4,
				'{leaderboard}:maker:volume:2025-10-20',
				user
			);

			// Taker volume calls
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				5,
				'{leaderboard}:taker:volume:verified:2025-10-17',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				6,
				'{leaderboard}:taker:volume:2025-10-18',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				7,
				'{leaderboard}:taker:volume:2025-10-19',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				8,
				'{leaderboard}:taker:volume:2025-10-20',
				user
			);

			// User PnL calls
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				9,
				'{leaderboard}:user:pnl:verified:2025-10-17',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				10,
				'{leaderboard}:user:pnl:2025-10-18',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				11,
				'{leaderboard}:user:pnl:2025-10-19',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				12,
				'{leaderboard}:user:pnl:2025-10-20',
				user
			);

			// Fee paid calls
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				13,
				'{leaderboard}:fees:paid:verified:2025-10-17',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				14,
				'{leaderboard}:fees:paid:2025-10-18',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				15,
				'{leaderboard}:fees:paid:2025-10-19',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				16,
				'{leaderboard}:fees:paid:2025-10-20',
				user
			);

			// Fee rebate calls
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				17,
				'{leaderboard}:fees:rebate:verified:2025-10-17',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				18,
				'{leaderboard}:fees:rebate:2025-10-18',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				19,
				'{leaderboard}:fees:rebate:2025-10-19',
				user
			);
			expect(pipeline.zScore).toHaveBeenNthCalledWith(
				20,
				'{leaderboard}:fees:rebate:2025-10-20',
				user
			);

			expect(result).toEqual({
				cumulativeMakerVolume: 35,
				cumulativeTakerVolume: 15,
				cumulativeRealizedPnl: 17,
				cumulativeFeePaid: 3.5,
				cumulativeFeeRebate: 0.4,
			});
		});

		it('uses today-only keys when no verified day', async () => {
			mockGet.mockResolvedValue(null);

			const user = 'user-123123';

			mockZScore.mockImplementation((key: string, member: string) => {
				expect(member).toBe(user);
				if (key === '{leaderboard}:maker:volume:2025-10-20') return Promise.resolve(123);
				if (key === '{leaderboard}:taker:volume:2025-10-20') return Promise.resolve(456);
				if (key === '{leaderboard}:user:pnl:2025-10-20') return Promise.resolve(50);
				if (key === '{leaderboard}:fees:paid:2025-10-20') return Promise.resolve(10);
				if (key === '{leaderboard}:fees:rebate:2025-10-20') return Promise.resolve(5);
				return Promise.resolve(null);
			});

			const result = await repository.getUserVolumeAndFees({ user });

			expect(result).toEqual({
				cumulativeMakerVolume: 123,
				cumulativeTakerVolume: 456,
				cumulativeRealizedPnl: 50,
				cumulativeFeePaid: 10,
				cumulativeFeeRebate: 5,
			});
			expect(mockZScore).toHaveBeenCalledTimes(5);
			expect(mockZScore).toHaveBeenCalledWith('{leaderboard}:maker:volume:2025-10-20', user);
			expect(mockZScore).toHaveBeenCalledWith('{leaderboard}:taker:volume:2025-10-20', user);
			expect(mockZScore).toHaveBeenCalledWith('{leaderboard}:user:pnl:2025-10-20', user);
			expect(mockZScore).toHaveBeenCalledWith('{leaderboard}:fees:paid:2025-10-20', user);
			expect(mockZScore).toHaveBeenCalledWith('{leaderboard}:fees:rebate:2025-10-20', user);
		});

		it('returns zeros when user has no scores', async () => {
			mockGet.mockResolvedValue(null);
			mockZScore.mockResolvedValue(null);
			const result = await repository.getUserVolumeAndFees({ user: 'nobody' });
			expect(result).toEqual({
				cumulativeMakerVolume: 0,
				cumulativeTakerVolume: 0,
				cumulativeRealizedPnl: 0,
				cumulativeFeePaid: 0,
				cumulativeFeeRebate: 0,
			});
		});
	});
});
