import {
	DeviceRecord,
	NotificationChannel,
	NotificationRecord,
	NotificationType,
} from '@backend/common';
import { FirebaseProvider } from '../../src/providers/firebase';

const mockGetDevices = jest.fn();
const mockRemoveDevice = jest.fn();
const mockGetPreferences = jest.fn();
jest.mock('@backend/dynamodb', () => {
	return {
		DeviceRepository: () => ({
			getDevices: (params: any) => mockGetDevices(params),
			removeDevice: (params: any) => mockRemoveDevice(params),
		}),
		NotificationRepository: () => ({
			getPreferences: (params: any) => mockGetPreferences(params),
		}),
	};
});

const mockApp = {
	name: '[DEFAULT]',
	options: {},
	getOrInitService: jest.fn(),
};

jest.mock('firebase-admin/app', () => ({
	initializeApp: jest.fn().mockReturnValue(() => mockApp),
	getApps: jest.fn().mockReturnValue(() => mockApp),
	cert: jest.fn(),
}));

const mockSend = jest.fn();
jest.mock('firebase-admin/messaging', () => ({
	getMessaging: () => ({
		send: (params: any) => mockSend(params),
	}),
}));

describe('Firebase Provider', () => {
	let firebaseProvider: any;

	beforeEach(() => {
		jest.clearAllMocks();
		mockGetPreferences.mockResolvedValue(null);

		// Set up environment variables
		process.env.FIREBASE_PROJECT_ID = 'test-project';
		process.env.FIREBASE_CLIENT_EMAIL = 'test@example.com';
		process.env.FIREBASE_PRIVATE_KEY = 'test-key';

		// Get a fresh instance of the provider for each test
		firebaseProvider = FirebaseProvider();
	});

	afterEach(() => {
		// Clean up environment variables
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.FIREBASE_CLIENT_EMAIL;
		delete process.env.FIREBASE_PRIVATE_KEY;
	});

	describe('isEnabled', () => {
		it('should be enabled when environment variables are set', () => {
			expect(firebaseProvider.isEnabled()).toBe(true);
		});
	});

	describe('canHandle', () => {
		it('should handle notifications with push channel', () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				channels: [NotificationChannel.PUSH],
			} as NotificationRecord;

			expect(firebaseProvider.canHandle(notification)).toBe(true);
		});

		it('should not handle notifications without push channel', () => {
			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				channels: [NotificationChannel.APP],
			} as NotificationRecord;

			expect(firebaseProvider.canHandle(notification)).toBe(false);
		});
	});

	describe('sendNotification', () => {
		it('should send notifications to all devices', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'token1', authorityId: 'auth1' },
				{ deviceId: 'device2', token: 'token2', authorityId: 'auth1' },
			];

			mockGetDevices.mockResolvedValue(devices);
			mockSend.mockResolvedValue('message-id');

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test Title',
				body: 'Test Body',
				data: { key: 'value' },
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await firebaseProvider.sendNotification(notification);

			expect(mockGetPreferences).toHaveBeenCalledWith('auth1');
			expect(mockGetDevices).toHaveBeenCalledWith('auth1');
			expect(mockSend).toHaveBeenCalledTimes(2);
			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({
					notification: {
						title: 'Test Title',
						body: 'Test Body',
					},
					token: expect.any(String),
				})
			);
		});

		it('should do nothing if no devices are found', async () => {
			mockGetDevices.mockResolvedValue([]);

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await firebaseProvider.sendNotification(notification);

			expect(mockGetPreferences).toHaveBeenCalledWith('auth1');
			expect(mockGetDevices).toHaveBeenCalledWith('auth1');
			expect(mockSend).not.toHaveBeenCalled();
		});

		it('should handle invalid tokens and remove devices', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'invalid-token', authorityId: 'auth1' },
			];

			mockGetDevices.mockResolvedValue(devices);
			mockSend.mockRejectedValue({
				code: 'messaging/invalid-registration-token',
				message: 'Invalid token',
			});

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await expect(firebaseProvider.sendNotification(notification)).rejects.toThrow();

			expect(mockRemoveDevice).toHaveBeenCalledWith({
				authorityId: 'auth1',
				deviceId: 'device1',
			});
		});

		it('should handle non-registered tokens and remove devices', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'old-token', authorityId: 'auth1' },
			];

			mockGetDevices.mockResolvedValue(devices);
			mockSend.mockRejectedValue({
				code: 'messaging/registration-token-not-registered',
				message: 'Token not registered',
			});

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await expect(firebaseProvider.sendNotification(notification)).rejects.toThrow();

			expect(mockRemoveDevice).toHaveBeenCalledWith({
				authorityId: 'auth1',
				deviceId: 'device1',
			});
		});

		it('should throw error if all devices fail', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'token1', authorityId: 'auth1' },
				{ deviceId: 'device2', token: 'token2', authorityId: 'auth1' },
			];

			mockGetDevices.mockResolvedValue(devices);
			mockSend.mockRejectedValue(new Error('Firebase error'));

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await expect(firebaseProvider.sendNotification(notification)).rejects.toThrow(
				'Failed to send Firebase notification to all devices for authority auth1'
			);
		});

		it('should succeed if at least one device succeeds', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'token1', authorityId: 'auth1' },
				{ deviceId: 'device2', token: 'token2', authorityId: 'auth1' },
			];

			mockGetDevices.mockResolvedValue(devices);
			mockSend
				.mockResolvedValueOnce('message-id')
				.mockRejectedValueOnce(new Error('Firebase error'));

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			// This should not throw because one device succeeds
			await firebaseProvider.sendNotification(notification);

			expect(mockSend).toHaveBeenCalledTimes(2);
		});

		it('should skip devices without tokens', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'token1', authorityId: 'auth1' },
				{ deviceId: 'device2', authorityId: 'auth1' }, // No token
			];

			mockGetDevices.mockResolvedValue(devices);
			mockSend.mockResolvedValue('message-id');

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await firebaseProvider.sendNotification(notification);

			// Should only call send once for the device with a token
			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it('should skip sending when notification type is opted out', async () => {
			mockGetPreferences.mockResolvedValue({
				authorityId: 'auth1',
				pushOptOutTypes: [NotificationType.PRICE_ALERT],
			});

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await firebaseProvider.sendNotification(notification);

			expect(mockGetPreferences).toHaveBeenCalledWith('auth1');
			expect(mockGetDevices).not.toHaveBeenCalled();
			expect(mockSend).not.toHaveBeenCalled();
		});

		it('should send when notification type is not opted out', async () => {
			const devices: DeviceRecord[] = [
				{ deviceId: 'device1', token: 'token1', authorityId: 'auth1' },
			];

			mockGetPreferences.mockResolvedValue({
				authorityId: 'auth1',
				pushOptOutTypes: [NotificationType.RECORD_UPDATE],
			});
			mockGetDevices.mockResolvedValue(devices);
			mockSend.mockResolvedValue('message-id');

			const notification = {
				authorityId: 'auth1',
				notificationId: '123',
				title: 'Test',
				body: 'Body',
				type: NotificationType.PRICE_ALERT,
			} as NotificationRecord;

			await firebaseProvider.sendNotification(notification);

			expect(mockGetPreferences).toHaveBeenCalledWith('auth1');
			expect(mockGetDevices).toHaveBeenCalledWith('auth1');
			expect(mockSend).toHaveBeenCalledTimes(1);
		});
	});
});
