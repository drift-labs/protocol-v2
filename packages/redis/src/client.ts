import { DEFAULT_REDIS_CLIENT, logger } from '@backend/common';
import { createCluster } from 'redis';

import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
	maxConcurrent: 5,
});

const BATCH_SIZE = 500;

export const Redis = ({
	overrideRedisUrl,
	proxyElasticache,
}: { overrideRedisUrl?: string; proxyElasticache?: boolean } = {}) => {
	const isProduction =
		process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.RUNNING_LOCAL === 'false';
	const redisUrl = overrideRedisUrl || process.env.REDIS_URL || DEFAULT_REDIS_CLIENT;

	let connectionPromise: Promise<void> | null = null;

	const client = createCluster({
		rootNodes: [
			{
				url: redisUrl,
			},
		],
		defaults: {
			socket: {
				tls: isProduction || proxyElasticache ? true : false,
				reconnectStrategy: (retries) => {
					const delay = Math.min(retries * 500, 5000);
					return delay;
				},
				...(proxyElasticache && {
					rejectUnauthorized: false,
				}),
			},
		},
		...(proxyElasticache && {
			nodeAddressMap: () => {
				return {
					host: `localhost`,
					port: 63790,
				};
			},
		}),
	});

	client.on('error', async (error) => {
		const { message } = error;
		await logger.error(`Redis Client Error: ${message}`);
		connectionPromise = null;
	});

	// Events do not currently work with a redis cluster
	client.on('connect', () => {
		logger.info('Redis Client Connected');
	});

	client.on('reconnecting', () => {
		logger.info('Redis Client Reconnecting');
	});

	client.on('end', () => {
		logger.info('Redis Client Connection Closed');
		connectionPromise = null;
	});

	const ensureConnection = async () => {
		if (!client.isOpen && !connectionPromise) {
			connectionPromise = client.connect().catch(async (error) => {
				const { message } = error;
				await logger.error(`Redis Initial Connection Error: ${message}`);
				connectionPromise = null;
				throw error;
			});
		}
		if (connectionPromise) {
			await connectionPromise;
		}
	};

	const retryOperation = async <T>(
		operation: () => Promise<T>,
		maxRetries = 5,
		baseDelay = 100
	): Promise<T> => {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				await ensureConnection();
				return await operation();
			} catch (error) {
				const { message } = error as Error;
				const delay = baseDelay + attempt * baseDelay;

				if (attempt === maxRetries) {
					await logger.error(
						`Redis operation failed after ${maxRetries} retries: ${message}`
					);
					throw error;
				}

				await logger.warn(
					`Redis operation failed, attempt ${
						attempt + 1
					}/${maxRetries}. Retrying in ${delay}ms`
				);

				await new Promise((resolve) => setTimeout(resolve, delay));
				connectionPromise = null;
			}
		}

		throw new Error('Redis Client: Internal server error');
	};

	const get = async (key: string) => {
		return retryOperation(async () => client.get(key));
	};

	const del = async (key: string) => {
		return retryOperation(async () => client.del(key));
	};

	const mGet = async (keys: string[]) => {
		return retryOperation(async () => client.mGet(keys));
	};

	const set = async (key: string, value: string) => {
		return retryOperation(async () => client.set(key, value, { KEEPTTL: true }));
	};

	const mSet = async (keyValuePairs: Record<string, string>) => {
		return retryOperation(async () => {
			const entries = Object.entries(keyValuePairs);

			if (entries.length <= BATCH_SIZE) {
				return client.mSet(entries.flat());
			}

			const batches = [];
			for (let i = 0; i < entries.length; i += BATCH_SIZE) {
				batches.push(entries.slice(i, i + BATCH_SIZE));
			}

			await Promise.all(
				batches.map((batch) => limiter.schedule(() => client.mSet(batch.flat())))
			);

			return 'OK';
		});
	};

	const mSetWithTTL = async (keyValuePairs: Record<string, string>) => {
		return retryOperation(async () => {
			const multi = client.multi();
			Object.entries(keyValuePairs).forEach(([key, value]) => {
				multi.set(key, value, { KEEPTTL: true });
			});
			return multi.exec();
		});
	};
	const setEx = async (key: string, seconds: number, value: string) => {
		return retryOperation(async () => client.setEx(key, seconds, value));
	};

	const setNX = async (key: string, seconds: number, value: string) => {
		return retryOperation(async () => client.set(key, value, { NX: true, EX: seconds }));
	};

	const zAdd = async (key: string, members: Array<{ score: number; value: string }>) => {
		return retryOperation(async () => client.zAdd(key, members));
	};

	const zRem = async (key: string, ...members: string[]) => {
		return retryOperation(async () => client.zRem(key, members));
	};

	const zCard = async (key: string) => {
		return retryOperation(async () => client.zCard(key));
	};

	const zScore = async (key: string, member: string) => {
		return retryOperation(async () => client.zScore(key, member));
	};

	const zMScore = async (key: string, ...members: string[]) => {
		return retryOperation(async () => client.zmScore(key, members));
	};

	const zRange = async (
		key: string,
		start: number,
		stop: number,
		reverse?: boolean,
		limit = 100
	) => {
		if (reverse) {
			return retryOperation(async () =>
				client.zRange(key, start, stop, {
					BY: 'SCORE',
					REV: true,
					LIMIT: { offset: 0, count: limit },
				})
			);
		}
		return retryOperation(async () => client.zRange(key, start, stop));
	};

	const zRevRank = async (key: string, member: string): Promise<number | null> => {
		return retryOperation(async () => client.zRevRank(key, member));
	};

	const zRemRangeByRank = async (key: string, start: number, stop: number) => {
		return retryOperation(async () => client.zRemRangeByRank(key, start, stop));
	};

	const zRangeWithScores = async (key: string, start: number, stop: number, reverse = false) => {
		if (reverse) {
			return retryOperation(async () =>
				client.zRangeWithScores(key, start, stop, { REV: true })
			);
		}
		return retryOperation(async () => client.zRangeWithScores(key, start, stop));
	};

	const zRangeByScore = async (
		key: string,
		min: number | string,
		max: number | string,
		opts?: { LIMIT?: { offset: number; count: number } }
	) => {
		return retryOperation(async () => client.zRangeByScore(key, min, max, opts));
	};

	const zDelta = async (key: string, compareKeys: string[]) => {
		if (compareKeys.length === 0) return 0;
		return retryOperation(async () =>
			client.zUnionStore(key, compareKeys, {
				WEIGHTS: [1, -1],
				AGGREGATE: 'SUM',
			})
		);
	};

	const zUnion = async (
		keys: string[],
		options?: { WEIGHTS?: number[]; AGGREGATE?: 'SUM' | 'MIN' | 'MAX' }
	) => {
		if (keys.length === 0) return [];
		return retryOperation(async () => client.zUnionWithScores(keys, options));
	};

	const zUnionStore = async (
		key: string,
		compareKeys: string[],
		options?: { WEIGHTS?: number[]; AGGREGATE?: 'SUM' | 'MIN' | 'MAX' }
	) => {
		if (compareKeys.length === 0) return 0;
		return retryOperation(async () => client.zUnionStore(key, compareKeys, options));
	};

	const lRange = async (key: string, start: number, stop: number) => {
		return retryOperation(async () => client.lRange(key, start, stop));
	};

	const hIncrByFloat = async (key: string, field: string, increment: number) => {
		return retryOperation(() => client.hIncrByFloat(key, field, increment));
	};

	const expire = async (key: string, seconds: number) => {
		return retryOperation(() => client.expire(key, seconds));
	};

	const sAdd = async (key: string, member: string) => {
		return retryOperation(() => client.sAdd(key, member));
	};

	const sMembers = async (key: string) => {
		return retryOperation(() => client.sMembers(key));
	};

	const hGet = async (key: string, field: string) => {
		return retryOperation(async () => client.hGet(key, field));
	};

	const hSet = async (key: string, field: string, value: string) => {
		return retryOperation(async () => client.hSet(key, field, value));
	};

	const hGetAll = async (key: string) => {
		return retryOperation(async () => {
			const result = await client.hGetAll(key);
			return Object.keys(result).length > 0 ? result : null;
		});
	};

	const hmSet = async (key: string, keyValuePairs: Record<string, string>) => {
		return retryOperation(() => client.hSet(key, keyValuePairs));
	};

	const copy = async (channel: string, destination: string) => {
		return retryOperation(async () => client.copy(channel, destination, { replace: true }));
	};

	const publish = async (channel: string, message: string) => {
		return retryOperation(async () => client.publish(channel, message));
	};

	const exists = async (key: string) => {
		return retryOperation(async () => client.exists(key));
	};

	const executeInPipeline = async (operations: (pipeline: any) => void) => {
		return retryOperation(async () => {
			await ensureConnection();
			const pipeline = client.multi();
			operations(pipeline);
			return pipeline.exec();
		});
	};

	const subscribe = async (
		channels: string[],
		onMessage: (channel: string, message: string) => void
	) => {
		return retryOperation(async () => client.subscribe(channels, onMessage));
	};

	const unsubscribe = async (channels: string[]) => {
		return retryOperation(async () => client.unsubscribe(channels));
	};

	const disconnect = async () => {
		if (client.isOpen) {
			await client.quit();
			connectionPromise = null;
		}
	};

	return {
		get,
		del,
		mGet,
		set,
		mSet,
		mSetWithTTL,
		setEx,
		setNX,
		zAdd,
		zRem,
		zScore,
		zMScore,
		zCard,
		zRange,
		zRangeByScore,
		zRevRank,
		zRemRangeByRank,
		zRangeWithScores,
		zDelta,
		zUnionStore,
		zUnion,
		lRange,
		hIncrByFloat,
		expire,
		sAdd,
		sMembers,
		hGet,
		hSet,
		hGetAll,
		hmSet,
		copy,
		exists,
		executeInPipeline,
		publish,
		subscribe,
		unsubscribe,
		disconnect,
	};
};
