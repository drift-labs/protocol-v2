import {
	NotificationChannel,
	NotificationRecord,
	NotificationType,
	RecordTypes,
} from '@backend/common';
import { DialectProvider } from '../../src/providers/dialect';

const mockDialectDappMessagesSend = jest.fn();
const mockDialectDappsFind = jest.fn();
const mockDialectNotificationTypesFindAll = jest.fn();

jest.mock('@dialectlabs/sdk', () => {
	return {
		Dialect: {
			sdk: jest.fn().mockReturnValue({
				dapps: {
					find: () => mockDialectDappsFind(),
				},
			}),
		},
		DappMessageActionType: {
			LINK: 'LINK',
		},
		DialectCloudEnvironment: {
			development: 'development',
			production: 'production',
		},
	};
});

jest.mock('@dialectlabs/blockchain-sdk-solana', () => {
	return {
		SolanaSdkFactory: {
			create: jest.fn().mockReturnValue({}),
		},
		NodeDialectSolanaWalletAdapter: {
			create: jest.fn(),
		},
	};
});

describe('Dialect Provider', () => {
	let dialectProvider: any;

	beforeEach(() => {
		jest.clearAllMocks();

		process.env.DIALECT_SDK_CREDENTIALS = 'test-credentials';
		process.env.DIALECT_ENVIRONMENT = 'development';
		process.env.DEFAULT_DIALECT_NOTIFICATION_TYPE_ID = 'default-type-id';

		const mockNotificationTypes = [
			{
				id: 'liquidation-warning-id',
				humanReadableId: 'liquidation-warning',
				name: 'Liquidation Warning',
			},
			{
				id: 'liquidation-alert-id',
				humanReadableId: 'liquidation-alert',
				name: 'Liquidation Alert',
			},
			{
				id: 'default-type-id',
				humanReadableId: 'default',
				name: 'Default Notification',
			},
		];

		mockDialectNotificationTypesFindAll.mockResolvedValue(mockNotificationTypes);

		mockDialectDappsFind.mockResolvedValue({
			messages: {
				send: mockDialectDappMessagesSend,
			},
			notificationTypes: {
				findAll: mockDialectNotificationTypesFindAll,
			},
		});

		mockDialectDappMessagesSend.mockResolvedValue(undefined);

		dialectProvider = DialectProvider();
	});

	afterEach(() => {
		delete process.env.DIALECT_SDK_CREDENTIALS;
		delete process.env.DIALECT_ENVIRONMENT;
		delete process.env.DEFAULT_DIALECT_NOTIFICATION_TYPE_ID;
	});

	describe('isEnabled', () => {
		it('should be enabled when environment variables are set', () => {
			expect(dialectProvider.isEnabled()).toBe(true);
		});
		it('should be disabled when environment variables are not set', () => {
			delete process.env.DIALECT_SDK_CREDENTIALS;
			expect(dialectProvider.isEnabled()).toBe(false);
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

			expect(dialectProvider.canHandle(notification)).toBe(true);
		});

		it('should not handle notifications without app channel', () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				channels: [NotificationChannel.PUSH],
			} as NotificationRecord;

			expect(dialectProvider.canHandle(notification)).toBe(false);
		});
	});

	describe('sendNotification', () => {
		it('should send notifications through Dialect SDK', async () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				user: 'wallet123',
			} as NotificationRecord;

			await dialectProvider.sendNotification(notification);

			expect(mockDialectDappsFind).toHaveBeenCalled();
			expect(mockDialectNotificationTypesFindAll).toHaveBeenCalled();
			expect(mockDialectDappMessagesSend).toHaveBeenCalledWith({
				title: 'Test Title',
				message: 'Test Body',
				recipient: 'auth1',
				notificationTypeId: 'default-type-id',
			});
		});

		it('should use specific notification type for ACCOUNT_UPDATE', async () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				user: 'wallet123',
				type: NotificationType.ACCOUNT_UPDATE,
			} as NotificationRecord;

			await dialectProvider.sendNotification(notification);

			expect(mockDialectDappMessagesSend).toHaveBeenCalledWith({
				message: 'Test Body',
				notificationTypeId: 'liquidation-warning-id',
				recipient: 'auth1',
				title: 'Test Title',
			});
		});

		it('should use specific notification type for liquidation record updates', async () => {
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

			await dialectProvider.sendNotification(notification);

			expect(mockDialectDappMessagesSend).toHaveBeenCalledWith({
				message: 'Test Body',
				notificationTypeId: 'liquidation-alert-id',
				recipient: 'auth1',
				title: 'Test Title',
			});
		});

		it('should throw error if Dialect SDK fails', async () => {
			mockDialectDappMessagesSend.mockRejectedValue(new Error('Dialect error'));

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				user: 'wallet123',
			} as NotificationRecord;

			await expect(dialectProvider.sendNotification(notification)).rejects.toThrow(
				'Dialect error'
			);
		});

		it('should return early if dapp is not found', async () => {
			mockDialectDappsFind.mockResolvedValue(null);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				user: 'wallet123',
			} as NotificationRecord;

			await expect(dialectProvider.sendNotification(notification)).rejects.toThrow(
				'Unable to find dialect dapp'
			);

			expect(mockDialectDappMessagesSend).not.toHaveBeenCalled();
		});

		it('should use default notification type id if no matching type found', async () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				user: 'wallet123',
				type: 'UNKNOWN_TYPE' as NotificationType,
			} as NotificationRecord;

			await dialectProvider.sendNotification(notification);

			expect(mockDialectDappMessagesSend).toHaveBeenCalledWith({
				message: 'Test Body',
				notificationTypeId: 'default-type-id',
				recipient: 'auth1',
				title: 'Test Title',
			});
		});
	});
});
