import { NotificationChannel, NotificationRecord } from '@backend/common';
import {
	getEnabledProviders,
	getProvidersForNotification,
	isLiveSendingEnabled,
	processNotification,
	registerAllProviders,
	registerProvider,
	resetRegistry,
} from '../../src/providers';
import { DialectProvider } from '../../src/providers/dialect';
import { FirebaseProvider } from '../../src/providers/firebase';
import { NotificationProvider } from '../../src/types';

const mockUpdateNotificationStatus = jest.fn();
jest.mock('@backend/dynamodb', () => ({
	NotificationRepository: jest.fn(() => ({
		updateNotificationStatus: mockUpdateNotificationStatus,
	})),
}));

jest.mock('../../src/providers/firebase', () => ({
	FirebaseProvider: jest.fn(),
}));

jest.mock('../../src/providers/dialect', () => ({
	DialectProvider: jest.fn(),
}));

describe('Provider Registry', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		resetRegistry();
		process.env = { ...originalEnv };
	});

	describe('registerProvider and getEnabledProviders', () => {
		it('should register a provider and return it when enabled', () => {
			const mockProvider: NotificationProvider = {
				id: 'mock',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn(),
			};

			registerProvider(mockProvider);

			const enabledProviders = getEnabledProviders();
			expect(enabledProviders).toContainEqual(expect.objectContaining({ id: 'mock' }));
		});

		it('should not return disabled providers', () => {
			const enabledProvider: NotificationProvider = {
				id: 'enabled',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn(),
				sendNotification: jest.fn(),
			};

			const disabledProvider: NotificationProvider = {
				id: 'disabled',
				isEnabled: jest.fn().mockReturnValue(false),
				canHandle: jest.fn(),
				sendNotification: jest.fn(),
			};

			registerProvider(enabledProvider);
			registerProvider(disabledProvider);

			const enabledProviders = getEnabledProviders();

			expect(enabledProviders).toContainEqual(expect.objectContaining({ id: 'enabled' }));

			expect(enabledProviders.find((p) => p.id === 'disabled')).toBeUndefined();
			expect(enabledProvider.isEnabled).toHaveBeenCalled();
			expect(disabledProvider.isEnabled).toHaveBeenCalled();
		});

		it('should return empty array if no providers are enabled', () => {
			const disabledProvider: NotificationProvider = {
				id: 'disabled',
				isEnabled: jest.fn().mockReturnValue(false),
				canHandle: jest.fn(),
				sendNotification: jest.fn(),
			};

			registerProvider(disabledProvider);

			const enabledProviders = getEnabledProviders();

			expect(enabledProviders).toHaveLength(0);
		});
	});

	describe('getProvidersForNotification', () => {
		it('should return providers that can handle the notification', () => {
			const handlingProvider: NotificationProvider = {
				id: 'handling',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn(),
			};

			const nonHandlingProvider: NotificationProvider = {
				id: 'non-handling',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(false),
				sendNotification: jest.fn(),
			};

			registerProvider(handlingProvider);
			registerProvider(nonHandlingProvider);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			const providers = getProvidersForNotification(notification);

			expect(providers).toContainEqual(expect.objectContaining({ id: 'handling' }));

			expect(providers.find((p) => p.id === 'non-handling')).toBeUndefined();
			expect(handlingProvider.canHandle).toHaveBeenCalledWith(notification);
			expect(nonHandlingProvider.canHandle).toHaveBeenCalledWith(notification);
		});

		it('should only consider enabled providers', () => {
			const enabledHandlingProvider: NotificationProvider = {
				id: 'enabled-handling',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn(),
			};

			const disabledHandlingProvider: NotificationProvider = {
				id: 'disabled-handling',
				isEnabled: jest.fn().mockReturnValue(false),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn(),
			};

			registerProvider(enabledHandlingProvider);
			registerProvider(disabledHandlingProvider);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			const providers = getProvidersForNotification(notification);

			expect(providers).toContainEqual(expect.objectContaining({ id: 'enabled-handling' }));

			expect(providers.find((p) => p.id === 'disabled-handling')).toBeUndefined();
			expect(enabledHandlingProvider.canHandle).toHaveBeenCalledWith(notification);
			expect(disabledHandlingProvider.isEnabled).toHaveBeenCalled();
		});

		it('should respect notification channels when provided', () => {
			const firebaseProvider: NotificationProvider = {
				id: 'firebase',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest
					.fn()
					.mockImplementation(
						(notification: NotificationRecord) =>
							notification.channels?.includes(NotificationChannel.PUSH) ?? false
					),
				sendNotification: jest.fn(),
			};

			const dialectProvider: NotificationProvider = {
				id: 'dialect',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest
					.fn()
					.mockImplementation(
						(notification: NotificationRecord) =>
							notification.channels?.includes(NotificationChannel.APP) ?? false
					),
				sendNotification: jest.fn(),
			};

			registerProvider(firebaseProvider);
			registerProvider(dialectProvider);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				channels: [NotificationChannel.PUSH],
			} as NotificationRecord;

			const providers = getProvidersForNotification(notification);

			expect(providers).toContainEqual(expect.objectContaining({ id: 'firebase' }));
			expect(providers.find((p) => p.id === 'dialect')).toBeUndefined();
		});
	});

	describe('registerAllProviders', () => {
		it('should register all available providers', () => {
			const mockDialectProvider: NotificationProvider = {
				id: 'dialect',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn(),
				sendNotification: jest.fn(),
			};

			const mockFirebaseProvider: NotificationProvider = {
				id: 'firebase',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn(),
				sendNotification: jest.fn(),
			};

			(DialectProvider as jest.Mock).mockReturnValue(mockDialectProvider);
			(FirebaseProvider as jest.Mock).mockReturnValue(mockFirebaseProvider);

			registerAllProviders();

			const enabledProviders = getEnabledProviders();
			expect(enabledProviders.some((p) => p.id === 'dialect')).toBe(true);
			expect(DialectProvider).toHaveBeenCalled();
		});
	});

	describe('isLiveSendingEnabled', () => {
		it('should return true when NOTIFICATION_SENDING_ENABLED is "true"', () => {
			process.env.NOTIFICATION_SENDING_ENABLED = 'true';
			expect(isLiveSendingEnabled()).toBe(true);
		});

		it('should return false by default (dry run mode)', () => {
			delete process.env.NOTIFICATION_SENDING_ENABLED;
			expect(isLiveSendingEnabled()).toBe(false);

			process.env.NOTIFICATION_SENDING_ENABLED = 'false';
			expect(isLiveSendingEnabled()).toBe(false);

			process.env.NOTIFICATION_SENDING_ENABLED = 'anything-else';
			expect(isLiveSendingEnabled()).toBe(false);
		});
	});

	describe('processNotification in dry run mode', () => {
		it('should not call sendNotification in dry run mode (default)', async () => {
			delete process.env.NOTIFICATION_SENDING_ENABLED;

			const provider1: NotificationProvider = {
				id: 'provider1',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			const provider2: NotificationProvider = {
				id: 'provider2',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			registerProvider(provider1);
			registerProvider(provider2);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await processNotification(notification);

			expect(mockUpdateNotificationStatus).toHaveBeenCalled();
			expect(provider1.sendNotification).not.toHaveBeenCalled();
			expect(provider2.sendNotification).not.toHaveBeenCalled();
		});

		it('should call sendNotification in dry run mode with whitelisting', async () => {
			delete process.env.NOTIFICATION_SENDING_ENABLED;
			process.env.NOTIFICATION_WHITELIST_AUTHORITIES = 'auth1';

			const provider1: NotificationProvider = {
				id: 'provider1',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			const provider2: NotificationProvider = {
				id: 'provider2',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			registerProvider(provider1);
			registerProvider(provider2);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await processNotification(notification);

			expect(mockUpdateNotificationStatus).toHaveBeenCalled();
			expect(provider1.sendNotification).toHaveBeenCalled();
			expect(provider2.sendNotification).toHaveBeenCalled();
		});
	});

	describe('processNotification in live mode', () => {
		it('should process notification using all applicable providers when live sending is enabled', async () => {
			process.env.NOTIFICATION_SENDING_ENABLED = 'true';

			const provider1: NotificationProvider = {
				id: 'provider1',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			const provider2: NotificationProvider = {
				id: 'provider2',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			registerProvider(provider1);
			registerProvider(provider2);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await processNotification(notification);

			expect(mockUpdateNotificationStatus).toHaveBeenCalled();
			expect(provider1.sendNotification).toHaveBeenCalledWith(notification);
			expect(provider2.sendNotification).toHaveBeenCalledWith(notification);
		});

		it('should not throw if one provider succeeds and another fails in live mode', async () => {
			process.env.NOTIFICATION_SENDING_ENABLED = 'true';

			const successProvider: NotificationProvider = {
				id: 'success',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			const failureProvider: NotificationProvider = {
				id: 'failure',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockRejectedValue(new Error('Provider error')),
			};

			registerProvider(successProvider);
			registerProvider(failureProvider);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await processNotification(notification);

			expect(successProvider.sendNotification).toHaveBeenCalled();
			expect(failureProvider.sendNotification).toHaveBeenCalled();
		});

		it('should throw error if all providers fail in live mode', async () => {
			process.env.NOTIFICATION_SENDING_ENABLED = 'true';

			const failureProvider1: NotificationProvider = {
				id: 'failure1',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockRejectedValue(new Error('Provider 1 error')),
			};

			const failureProvider2: NotificationProvider = {
				id: 'failure2',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockRejectedValue(new Error('Provider 2 error')),
			};

			registerProvider(failureProvider1);
			registerProvider(failureProvider2);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await expect(processNotification(notification)).rejects.toThrow(
				'All notification providers failed for authority auth1'
			);
		});

		it('should log warning and return if no providers can handle notification in live mode', async () => {
			process.env.NOTIFICATION_SENDING_ENABLED = 'true';

			const provider: NotificationProvider = {
				id: 'provider',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(false),
				sendNotification: jest.fn(),
			};

			registerProvider(provider);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await processNotification(notification);

			expect(provider.sendNotification).not.toHaveBeenCalled();
		});

		it('should handle notifications with no authorityId in live mode', async () => {
			process.env.NOTIFICATION_SENDING_ENABLED = 'true';

			const provider: NotificationProvider = {
				id: 'provider',
				isEnabled: jest.fn().mockReturnValue(true),
				canHandle: jest.fn().mockReturnValue(true),
				sendNotification: jest.fn().mockResolvedValue(undefined),
			};

			registerProvider(provider);

			const notification = {
				notificationId: '123',
				title: 'Test',
				body: 'Body',
			} as NotificationRecord;

			await processNotification(notification);

			expect(provider.sendNotification).toHaveBeenCalledWith(notification);
		});
	});
});
