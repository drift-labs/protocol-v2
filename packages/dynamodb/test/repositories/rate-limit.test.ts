import { RateLimitMetric, RateLimitRepository } from '../../src/repositories/rate-limit';

const mockQuery = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
const mockUpdate = jest.fn().mockResolvedValue({});

jest.mock('../../src/client', () => ({
	DynamoDB: () => ({
		query: mockQuery,
		update: mockUpdate,
	}),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn(() => 1234567890),
	logger: {
		error: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
	},
}));

jest.mock('../../src/utils', () => ({
	getTTLTimestampFromRecord: jest.fn((ts: number) => Math.floor(ts / 1000) + 7200),
}));

describe('RateLimitRepository', () => {
	const {
		checkRateLimit,
		checkMultipleRateLimits,
		recordUsage,
		recordMultipleUsage,
		getUserUsage,
		getGlobalUsage,
		getUserUsageHistory,
		DEFAULT_RATE_LIMITS,
		RATE_LIMIT_WINDOW_MS,
	} = RateLimitRepository();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('checkRateLimit', () => {
		it('should allow transaction when no existing record and value within limit', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

			const result = await checkRateLimit('user1', 500, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
			});

			expect(result.allowed).toBe(true);
			expect(result.currentUsage).toBe(500);
			expect(result.limit).toBe(1000);
			expect(mockQuery).toHaveBeenCalledWith({
				pk: expect.stringContaining('RATE_LIMIT#user1#PRIORITY_FEES'),
				sk: expect.stringContaining('TS#'),
			});
		});

		it('should deny transaction when no existing record and value exceeds limit', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

			const result = await checkRateLimit('user1', 1500, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
			});

			expect(result.allowed).toBe(false);
			expect(result.currentUsage).toBe(1500);
			expect(result.limit).toBe(1000);
		});

		it('should allow transaction when existing usage plus new value within limit', async () => {
			mockQuery.mockResolvedValue({
				Items: [
					{
						userId: 'user1',
						metric: RateLimitMetric.PriorityFees,
						totalValue: 300,
						transactionCount: 5,
					},
				],
				LastEvaluatedKey: undefined,
			});

			const result = await checkRateLimit('user1', 500, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
			});

			expect(result.allowed).toBe(true);
			expect(result.currentUsage).toBe(800);
			expect(result.limit).toBe(1000);
		});

		it('should deny transaction when existing usage plus new value exceeds limit', async () => {
			mockQuery.mockResolvedValue({
				Items: [
					{
						userId: 'user1',
						metric: RateLimitMetric.PriorityFees,
						totalValue: 800,
						transactionCount: 10,
					},
				],
				LastEvaluatedKey: undefined,
			});

			const result = await checkRateLimit('user1', 300, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
			});

			expect(result.allowed).toBe(false);
			expect(result.currentUsage).toBe(1100);
			expect(result.limit).toBe(1000);
		});

		it('should fail open when query throws error', async () => {
			mockQuery.mockRejectedValue(new Error('DynamoDB error'));

			const result = await checkRateLimit('user1', 500, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
			});

			expect(result.allowed).toBe(true);
			expect(result.currentUsage).toBe(0);
		});

		it('should respect custom window size', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

			const customWindowMs = 30 * 60 * 1000; // 30 minutes
			await checkRateLimit('user1', 500, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
				windowMs: customWindowMs,
			});

			expect(mockQuery).toHaveBeenCalled();
		});

		it('should check different metrics independently', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

			await checkRateLimit('user1', 500, {
				metric: RateLimitMetric.PriorityFees,
				limit: 1000,
			});

			await checkRateLimit('user1', 10, {
				metric: RateLimitMetric.TransactionCount,
				limit: 100,
			});

			expect(mockQuery).toHaveBeenCalledTimes(2);
			expect(mockQuery).toHaveBeenNthCalledWith(1, {
				pk: expect.stringContaining('PRIORITY_FEES'),
				sk: expect.any(String),
			});
			expect(mockQuery).toHaveBeenNthCalledWith(2, {
				pk: expect.stringContaining('TRANSACTION_COUNT'),
				sk: expect.any(String),
			});
		});
	});

	describe('checkMultipleRateLimits', () => {
		it('should allow when all limits pass', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

			const result = await checkMultipleRateLimits('user1', [
				{
					metric: RateLimitMetric.PriorityFees,
					value: 500,
					limit: 1000,
				},
				{
					metric: RateLimitMetric.TransactionCount,
					value: 1,
					limit: 100,
				},
			]);

			expect(result.allowed).toBe(true);
			expect(result.failedMetric).toBeUndefined();
			expect(mockQuery).toHaveBeenCalledTimes(2);
		});

		it('should deny and return first failed metric', async () => {
			mockQuery
				.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
				.mockResolvedValueOnce({
					Items: [
						{
							userId: 'user1',
							metric: RateLimitMetric.TransactionCount,
							totalValue: 95,
							transactionCount: 95,
						},
					],
					LastEvaluatedKey: undefined,
				});

			const result = await checkMultipleRateLimits('user1', [
				{
					metric: RateLimitMetric.PriorityFees,
					value: 500,
					limit: 1000,
				},
				{
					metric: RateLimitMetric.TransactionCount,
					value: 10,
					limit: 100,
				},
			]);

			expect(result.allowed).toBe(false);
			expect(result.failedMetric).toBe(RateLimitMetric.TransactionCount);
			expect(result.currentUsage).toBe(105);
			expect(result.limit).toBe(100);
		});

		it('should fail open when error occurs', async () => {
			mockQuery.mockRejectedValue(new Error('DynamoDB error'));

			const result = await checkMultipleRateLimits('user1', [
				{
					metric: RateLimitMetric.PriorityFees,
					value: 500,
					limit: 1000,
				},
			]);

			expect(result.allowed).toBe(true);
		});

		it('should check all metrics even if one passes', async () => {
			mockQuery.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

			await checkMultipleRateLimits('user1', [
				{
					metric: RateLimitMetric.PriorityFees,
					value: 100,
					limit: 1000,
				},
				{
					metric: RateLimitMetric.TransactionCount,
					value: 1,
					limit: 100,
				},
			]);

			expect(mockQuery).toHaveBeenCalledTimes(2);
		});
	});

	describe('recordUsage', () => {
		it('should update user-specific record with correct parameters', async () => {
			mockUpdate.mockResolvedValue({});

			await recordUsage('user1', RateLimitMetric.PriorityFees, 500);

			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					pk: expect.stringContaining('RATE_LIMIT#user1#PRIORITY_FEES'),
					sk: expect.stringContaining('TS#'),
					updateExpression:
						'SET lastUpdatedTs = :timestamp, #ttl = :ttl, #metric = :metric ADD totalValue :value, transactionCount :one',
					expressionNames: {
						'#ttl': 'ttl',
						'#metric': 'metric',
					},
					expressionValues: {
						':value': 500,
						':one': 1,
						':timestamp': 1234567890,
						':metric': RateLimitMetric.PriorityFees,
						':ttl': expect.any(Number),
					},
				})
			);
		});

		it('should update global sharded record', async () => {
			mockUpdate.mockResolvedValue({});

			await recordUsage('user1', RateLimitMetric.PriorityFees, 500);

			// Should be called twice: once for user, once for global
			expect(mockUpdate).toHaveBeenCalledTimes(2);
			expect(mockUpdate).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					pk: expect.stringContaining('GLOBAL_RATE_LIMIT#PRIORITY_FEES#SHARD#6'),
					sk: expect.stringContaining('TS#'),
					updateExpression: 'ADD totalValue :value, transactionCount :one',
					expressionValues: expect.objectContaining({
						':value': 500,
						':one': 1,
					}),
				})
			);
		});

		it('should handle user update errors gracefully', async () => {
			mockUpdate.mockRejectedValueOnce(new Error('DynamoDB error')).mockResolvedValueOnce({});

			await recordUsage('user1', RateLimitMetric.PriorityFees, 500);

			// Should still attempt global update
			expect(mockUpdate).toHaveBeenCalledTimes(2);
		});

		it('should handle global update errors gracefully', async () => {
			mockUpdate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('DynamoDB error'));

			await recordUsage('user1', RateLimitMetric.PriorityFees, 500);

			// Should not throw
			expect(mockUpdate).toHaveBeenCalledTimes(2);
		});

		it('should use custom window size', async () => {
			mockUpdate.mockResolvedValue({});

			const customWindowMs = 30 * 60 * 1000;
			await recordUsage('user1', RateLimitMetric.PriorityFees, 500, customWindowMs);

			expect(mockUpdate).toHaveBeenCalled();
		});
	});

	describe('recordMultipleUsage', () => {
		it('should handle partial failures', async () => {
			mockUpdate
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({})
				.mockRejectedValueOnce(new Error('Error'))
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({});

			await recordMultipleUsage('user1', [
				{
					metric: RateLimitMetric.PriorityFees,
					value: 500,
				},
				{
					metric: RateLimitMetric.TransactionCount,
					value: 1,
				},
			]);

			// Should still complete
			expect(mockUpdate).toHaveBeenCalledTimes(4);
		});
	});

	describe('getUserUsage', () => {
		it('should query user usage for specific metric', async () => {
			mockQuery.mockResolvedValue({
				Items: [
					{
						userId: 'user1',
						metric: RateLimitMetric.PriorityFees,
						totalValue: 500,
						transactionCount: 10,
						windowStart: 1234567890,
					},
				],
				LastEvaluatedKey: undefined,
			});

			const result = await getUserUsage('user1', RateLimitMetric.PriorityFees);

			expect(result).toEqual({
				userId: 'user1',
				metric: RateLimitMetric.PriorityFees,
				totalValue: 500,
				transactionCount: 10,
				windowStart: 1234567890,
			});
			expect(mockQuery).toHaveBeenCalledWith({
				pk: expect.stringContaining('RATE_LIMIT#user1#PRIORITY_FEES'),
				sk: expect.stringContaining('TS#'),
			});
		});

		it('should return null when no usage exists', async () => {
			mockQuery.mockResolvedValue({
				Items: [],
				LastEvaluatedKey: undefined,
			});

			const result = await getUserUsage('user1', RateLimitMetric.PriorityFees);

			expect(result).toBeNull();
		});

		it('should handle query errors gracefully', async () => {
			mockQuery.mockRejectedValue(new Error('DynamoDB error'));

			const result = await getUserUsage('user1', RateLimitMetric.PriorityFees);

			expect(result).toBeNull();
		});
	});

	describe('getGlobalUsage', () => {
		it('should aggregate usage across all shards', async () => {
			mockQuery
				.mockResolvedValueOnce({
					Items: [
						{
							shard: 0,
							totalValue: 100,
							transactionCount: 5,
						},
					],
				})
				.mockResolvedValueOnce({
					Items: [
						{
							shard: 1,
							totalValue: 200,
							transactionCount: 10,
						},
					],
				})
				.mockResolvedValue({ Items: [] }); // Remaining shards empty

			const result = await getGlobalUsage(RateLimitMetric.PriorityFees);

			expect(result).toEqual({
				metric: RateLimitMetric.PriorityFees,
				windowStart: expect.any(Number),
				totalValue: 300,
				transactionCount: 15,
			});
			expect(mockQuery).toHaveBeenCalledTimes(10); // All shards queried
		});

		it('should return null when no usage across all shards', async () => {
			mockQuery.mockResolvedValue({ Items: [] });

			const result = await getGlobalUsage(RateLimitMetric.PriorityFees);

			expect(result).toBeNull();
		});

		it('should handle partial shard failures', async () => {
			mockQuery
				.mockResolvedValueOnce({
					Items: [
						{
							shard: 0,
							totalValue: 100,
							transactionCount: 5,
							uniqueUserIds: new Set(['user1']),
						},
					],
				})
				.mockRejectedValueOnce(new Error('Shard error'))
				.mockResolvedValue({ Items: [] });

			const result = await getGlobalUsage(RateLimitMetric.PriorityFees);

			// Should still fail and return null due to error
			expect(result).toBeNull();
		});
	});

	describe('getUserUsageHistory', () => {
		it('should query user usage history with correct parameters', async () => {
			const startTs = 1000000000;
			const endTs = 2000000000;

			mockQuery.mockResolvedValue({
				Items: [
					{
						userId: 'user1',
						metric: RateLimitMetric.PriorityFees,
						windowStart: 1500000000,
						totalValue: 500,
						transactionCount: 10,
					},
				],
				LastEvaluatedKey: undefined,
			});

			const result = await getUserUsageHistory({
				userId: 'user1',
				metric: RateLimitMetric.PriorityFees,
				startTs,
				endTs,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				pk: expect.stringContaining('RATE_LIMIT#user1#PRIORITY_FEES'),
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': expect.stringContaining('RATE_LIMIT#user1#PRIORITY_FEES'),
					':startSk': `TS#${startTs}`,
					':endSk': `TS#${endTs}`,
				},
				lastEvaluatedKey: undefined,
			});

			expect(result.records).toHaveLength(1);
			expect(result.meta.nextPage).toBeNull();
		});
	});
});
