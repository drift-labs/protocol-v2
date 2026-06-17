import {
	NotificationChannel,
	NotificationRecord,
	NotificationType,
	RecordTypes,
} from '@backend/common';
import { RedisProvider } from '../../src/providers/redis';

const mockRedisPublish = jest.fn();
jest.mock('@backend/redis', () => {
	return {
		Redis: jest.fn().mockReturnValue({
			publish: (channel: string, data: any) => mockRedisPublish(channel, data),
		}),
	};
});

describe('Redis Provider', () => {
	let redisProvider: any;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		mockRedisPublish.mockResolvedValue(1);
		redisProvider = RedisProvider();
	});

	afterEach(() => {
		jest.resetModules();
	});

	describe('isEnabled', () => {
		it('should be enabled when REDIS_URL environment variable is set', () => {
			expect(redisProvider.isEnabled()).toBe(true);
		});

		it('should be disabled when REDIS_URL environment variable is not set', () => {
			delete process.env.REDIS_URL;
			const provider = RedisProvider();
			expect(provider.isEnabled()).toBe(false);
		});

		it('should return false if Redis initialization fails', () => {
			delete process.env.REDIS_URL;
			const provider = RedisProvider();
			expect(provider.isEnabled()).toBe(false);
		});
	});

	describe('canHandle', () => {
		it('should handle notifications with app channel', () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				user: 'wallet123',
				channels: [NotificationChannel.APP],
			} as NotificationRecord;

			expect(redisProvider.canHandle(notification)).toBe(true);
		});

		it('should not handle notifications without app channel', () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				channels: [NotificationChannel.PUSH],
			} as NotificationRecord;

			expect(redisProvider.canHandle(notification)).toBe(false);
		});
	});

	describe('sendNotification', () => {
		it('should publish notification to Redis channel', async () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				user: 'wallet123',
			} as NotificationRecord;

			await redisProvider.sendNotification(notification);

			expect(mockRedisPublish).toHaveBeenCalledWith(
				'notifications:auth1',
				JSON.stringify(notification)
			);
		});

		it('should publish notification with all notification types', async () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				user: 'wallet123',
				type: NotificationType.ACCOUNT_UPDATE,
			} as NotificationRecord;

			await redisProvider.sendNotification(notification);

			expect(mockRedisPublish).toHaveBeenCalledWith(
				'notifications:auth1',
				JSON.stringify(notification)
			);
		});

		it('should publish notification with record type data', async () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				user: 'wallet123',
				type: NotificationType.RECORD_UPDATE,
				data: {
					recordType: RecordTypes.LiquidationRecord,
				},
			} as NotificationRecord;

			await redisProvider.sendNotification(notification);

			expect(mockRedisPublish).toHaveBeenCalledWith(
				'notifications:auth1',
				JSON.stringify(notification)
			);
		});

		it('should throw error if Redis publish fails', async () => {
			mockRedisPublish.mockRejectedValue(new Error('Redis connection error'));

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				user: 'wallet123',
			} as NotificationRecord;

			await expect(redisProvider.sendNotification(notification)).rejects.toThrow(
				'Redis connection error'
			);
		});

		it('should use correct channel format for different authority IDs', async () => {
			const authorities = ['auth1', 'auth2', 'user-123', 'wallet-abc'];

			for (const authorityId of authorities) {
				const notification = {
					authorityId,
					notificationId: '123',
					title: 'Test',
					body: 'Body',
					user: 'wallet123',
				} as NotificationRecord;

				await redisProvider.sendNotification(notification);

				expect(mockRedisPublish).toHaveBeenCalledWith(
					`notifications:${authorityId}`,
					JSON.stringify(notification)
				);
			}

			expect(mockRedisPublish).toHaveBeenCalledTimes(authorities.length);
		});
	});
});
