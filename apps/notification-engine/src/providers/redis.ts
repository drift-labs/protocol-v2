import { filterOutKeys, logger, NotificationChannel, NotificationRecord } from '@backend/common';
import { Redis } from '@backend/redis';
import { NotificationProvider } from '../types';

let redisClient: ReturnType<typeof Redis> | null = null;

const initializeRedis = (): void => {
	if (redisClient) {
		return;
	}

	try {
		redisClient = Redis();
		logger.info('Redis notification provider initialized successfully');
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Failed to initialize Redis: ${message}`);
		throw error;
	}
};

export const RedisProvider = (): NotificationProvider => {
	const isEnabled = (): boolean => {
		const enabled = Boolean(process.env.REDIS_URL);

		if (enabled && !redisClient) {
			try {
				initializeRedis();
			} catch (error) {
				const { message } = error as Error;
				logger.error(`Failed to initialize Redis in isEnabled check: ${message}`);
				return false;
			}
		}

		return enabled && !!redisClient;
	};

	return {
		id: 'redis',
		isEnabled,
		canHandle: (notification: NotificationRecord): boolean => {
			return (
				Boolean(notification.authorityId) &&
				Boolean(notification.channels?.includes(NotificationChannel.APP))
			);
		},
		sendNotification: async (notification: NotificationRecord): Promise<void> => {
			if (!redisClient) {
				throw new Error('Redis client not initialized');
			}

			try {
				const channel = `notifications:${notification.authorityId}`;
				await redisClient.publish(channel, JSON.stringify(filterOutKeys(notification)));
				logger.info(
					`Successfully published notification to Redis channel ${channel} for authority ${notification.authorityId}`
				);
			} catch (error) {
				const { message } = error as Error;
				logger.error(
					`Failed to publish notification to Redis for authority ${notification.authorityId}: ${message}`
				);
				throw error;
			}
		},
	};
};
