import {
	BaseDynamoRecord,
	DEFAULT_ANALYTICS_TABLE,
	getShard,
	getTimestamp,
	logger,
} from '@backend/common';
import { DynamoDB, getTTLTimestampFromRecord } from '..';

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export enum RateLimitMetric {
	PriorityFees = 'PRIORITY_FEES',
	TransactionCount = 'TRANSACTION_COUNT',
}

export interface RateLimitConfig {
	metric: RateLimitMetric;
	limit: number;
	windowMs?: number;
}

export const DEFAULT_RATE_LIMITS: Record<RateLimitMetric, number> = {
	[RateLimitMetric.PriorityFees]: 10_000_000, // 10M lamports per hour
	[RateLimitMetric.TransactionCount]: 100,
};

export interface UserUsageRecord {
	userId: string;
	metric: RateLimitMetric;
	windowStart: number;
	totalValue: number;
	transactionCount: number;
	ts: number;
}

export interface GlobalUsageRecord {
	shard: number;
	metric: RateLimitMetric;
	windowStart: number;
	totalValue: number;
	transactionCount: number;
	uniqueUserIds: Set<string>;
	ts: number;
}

const USER_RATE_LIMIT_PK = 'USER_RATE_LIMIT';
const GLOBAL_RATE_LIMIT_PK = 'GLOBAL_RATE_LIMIT';
const NUM_GLOBAL_SHARDS = 10;

export const RateLimitRepository = () => {
	const { query, update } = DynamoDB({
		overrideTableName: process.env.ANALYTICS_TABLE ?? DEFAULT_ANALYTICS_TABLE,
	});

	const getCurrentWindow = (windowMs: number = RATE_LIMIT_WINDOW_MS): number => {
		const now = Date.now();
		return Math.floor(now / windowMs) * windowMs;
	};

	const checkRateLimit = async (
		userId: string,
		value: number,
		config: RateLimitConfig
	): Promise<{
		allowed: boolean;
		currentUsage: number;
		limit: number;
		windowStart: number;
	}> => {
		const windowMs = config.windowMs || RATE_LIMIT_WINDOW_MS;
		const windowStart = getCurrentWindow(windowMs);
		const limit = config.limit;

		try {
			const { Items = [] } = await query({
				pk: `${USER_RATE_LIMIT_PK}#${userId}#${config.metric}`,
				sk: `TS#${windowStart}`,
			});

			if (Items.length === 0) {
				return {
					allowed: value <= limit,
					currentUsage: value,
					limit,
					windowStart,
				};
			}

			const record = Items[0] as UserUsageRecord & BaseDynamoRecord;
			const newTotal = record.totalValue + value;

			return {
				allowed: newTotal <= limit,
				currentUsage: newTotal,
				limit,
				windowStart,
			};
		} catch (error) {
			logger.warn(
				`Error checking rate limit: ${JSON.stringify({
					error,
					userId,
					metric: config.metric,
				})}`
			);

			return {
				allowed: true,
				currentUsage: 0,
				limit,
				windowStart,
			};
		}
	};

	const checkMultipleRateLimits = async (
		userId: string,
		values: { metric: RateLimitMetric; value: number; limit: number }[]
	): Promise<{
		allowed: boolean;
		failedMetric?: RateLimitMetric;
		currentUsage?: number;
		limit?: number;
	}> => {
		try {
			const checks = await Promise.all(
				values.map(({ metric, value, limit }) =>
					checkRateLimit(userId, value, { metric, limit })
				)
			);

			for (let i = 0; i < checks.length; i++) {
				if (!checks[i].allowed) {
					return {
						allowed: false,
						failedMetric: values[i].metric,
						currentUsage: checks[i].currentUsage,
						limit: checks[i].limit,
					};
				}
			}

			return { allowed: true };
		} catch (error) {
			logger.error(
				`Error checking multiple rate limits: ${JSON.stringify({ error, userId })}`
			);
			// Fail open
			return { allowed: true };
		}
	};

	const recordUsage = (
		userId: string,
		metric: RateLimitMetric,
		value: number,
		windowMs: number = RATE_LIMIT_WINDOW_MS
	): void => {
		const windowStart = getCurrentWindow(windowMs);
		const timestamp = getTimestamp();
		const shard = getShard(userId, NUM_GLOBAL_SHARDS);

		// Fire both updates in parallel without awaiting
		// User-specific record
		update({
			pk: `${USER_RATE_LIMIT_PK}#${userId}#${metric}`,
			sk: `TS#${windowStart}`,
			updateExpression:
				'SET lastUpdatedTs = :timestamp, #ttl = :ttl, #metric = :metric ADD totalValue :value, transactionCount :one',
			expressionNames: {
				'#ttl': 'ttl',
				'#metric': 'metric',
			},
			expressionValues: {
				':value': value,
				':one': 1,
				':timestamp': timestamp,
				':metric': metric,
				':ttl': getTTLTimestampFromRecord(getTimestamp()),
			},
		}).catch((error) => {
			logger.warn(
				`Error recording user usage: ${JSON.stringify({
					error,
					userId,
					metric,
					windowStart,
					value,
				})}`
			);
		});

		// Global sharded record
		update({
			pk: `${GLOBAL_RATE_LIMIT_PK}#${metric}#SHARD#${shard}`,
			sk: `TS#${windowStart}`,
			updateExpression: 'ADD totalValue :value, transactionCount :one',
			expressionValues: {
				':value': value,
				':one': 1,
			},
		}).catch((error) => {
			logger.warn(
				`Error recording global usage: ${JSON.stringify({ error, metric, shard })}`
			);
		});
	};

	const recordMultipleUsage = (
		userId: string,
		values: { metric: RateLimitMetric; value: number }[],
		windowMs: number = RATE_LIMIT_WINDOW_MS
	): void => {
		for (const { metric, value } of values) {
			recordUsage(userId, metric, value, windowMs);
		}
	};

	const getUserUsage = async (
		userId: string,
		metric: RateLimitMetric,
		windowMs: number = RATE_LIMIT_WINDOW_MS
	): Promise<(UserUsageRecord & BaseDynamoRecord) | null> => {
		const windowStart = getCurrentWindow(windowMs);

		try {
			const { Items = [] } = await query({
				pk: `${USER_RATE_LIMIT_PK}#${userId}#${metric}`,
				sk: `TS#${windowStart}`,
			});

			if (Items.length === 0) {
				return null;
			}

			return Items[0] as UserUsageRecord & BaseDynamoRecord;
		} catch (error) {
			logger.warn(`Error getting user usage: ${JSON.stringify({ error, userId, metric })}`);
			return null;
		}
	};

	const getGlobalUsage = async (
		metric: RateLimitMetric,
		windowMs: number = RATE_LIMIT_WINDOW_MS
	): Promise<{
		metric: RateLimitMetric;
		windowStart: number;
		totalValue: number;
		transactionCount: number;
	} | null> => {
		const windowStart = getCurrentWindow(windowMs);

		try {
			const shardQueries = Array.from({ length: NUM_GLOBAL_SHARDS }, (_, i) =>
				query({
					pk: `${GLOBAL_RATE_LIMIT_PK}#${metric}#SHARD#${i}`,
					sk: `TS#${windowStart}`,
				})
			);

			const results = await Promise.all(shardQueries);

			let totalValue = 0;
			let transactionCount = 0;

			results.forEach(({ Items = [] }) => {
				if (Items.length > 0) {
					const record = Items[0] as GlobalUsageRecord & BaseDynamoRecord;
					totalValue += record.totalValue || 0;
					transactionCount += record.transactionCount || 0;
				}
			});

			if (totalValue === 0 && transactionCount === 0) {
				return null;
			}

			return {
				metric,
				windowStart,
				totalValue,
				transactionCount,
			};
		} catch (error) {
			logger.warn(`Error getting global usage: ${JSON.stringify({ error, metric })}`);
			return null;
		}
	};

	const getUserUsageHistory = async ({
		userId,
		metric,
		startTs,
		endTs,
		page = undefined,
	}: {
		userId: string;
		metric: RateLimitMetric;
		startTs: number;
		endTs: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (UserUsageRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		try {
			const { Items = [], LastEvaluatedKey = null } = await query({
				pk: `${USER_RATE_LIMIT_PK}#${userId}#${metric}`,
				expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
				expressionValues: {
					':pk': `${USER_RATE_LIMIT_PK}#${userId}#${metric}`,
					':startSk': `TS#${startTs}`,
					':endSk': `TS#${endTs}`,
				},
				lastEvaluatedKey: page,
			});

			const records = Items as (UserUsageRecord & BaseDynamoRecord)[];

			return { records, meta: { nextPage: LastEvaluatedKey } };
		} catch (error) {
			logger.warn(
				`Error getting user usage history: ${JSON.stringify({
					error,
					userId,
					metric,
					startTs,
					endTs,
				})}`
			);
			return { records: [], meta: { nextPage: null } };
		}
	};

	return {
		checkRateLimit,
		checkMultipleRateLimits,
		recordUsage,
		recordMultipleUsage,
		getUserUsage,
		getGlobalUsage,
		getUserUsageHistory,

		DEFAULT_RATE_LIMITS,
		RATE_LIMIT_WINDOW_MS,
	};
};
