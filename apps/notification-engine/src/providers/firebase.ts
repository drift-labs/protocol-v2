import { DeviceRecord, logger, NotificationChannel, NotificationRecord } from '@backend/common';
import { DeviceRepository, NotificationRepository } from '@backend/dynamodb';
import Bottleneck from 'bottleneck';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { NotificationProvider } from '../types';

const limiter = new Bottleneck({
	maxConcurrent: 450,
});

let firebaseApp: App | null = null;
let messaging: Messaging | null = null;

const initializeFirebase = (): void => {
	const existingApps = getApps();
	if (existingApps.length > 0) {
		firebaseApp = existingApps[0];
		messaging = getMessaging(firebaseApp);
		return;
	}

	const projectId = process.env.FIREBASE_PROJECT_ID;
	const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
	const privateKey = process.env.FIREBASE_PRIVATE_KEY;

	if (!projectId || !clientEmail || !privateKey) {
		throw new Error('Missing required Firebase environment variables');
	}

	try {
		firebaseApp = initializeApp({
			credential: cert({
				projectId,
				clientEmail,
				privateKey: privateKey.replace(/\\n/g, '\n'),
			}),
		});
		messaging = getMessaging(firebaseApp);
		logger.info('Firebase notification provider initialized successfully');
	} catch (error) {
		const { message } = error;
		logger.error(`Failed to initialize Firebase: ${message}`);
		throw error;
	}
};

export const FirebaseProvider = (): NotificationProvider => {
	const { getDevices, removeDevice } = DeviceRepository();
	const { getPreferences } = NotificationRepository();

	const isEnabled = (): boolean => {
		const enabled = Boolean(
			process.env.FIREBASE_PROJECT_ID &&
				process.env.FIREBASE_CLIENT_EMAIL &&
				process.env.FIREBASE_PRIVATE_KEY
		);

		if (enabled && !firebaseApp) {
			try {
				initializeFirebase();
			} catch (error) {
				const { message } = error;
				logger.error(`Failed to initialize Firebase in isEnabled check: ${message}`);
				return false;
			}
		}

		return enabled && !!messaging;
	};

	const sendToDevice = async (
		notification: NotificationRecord,
		device: DeviceRecord
	): Promise<void> => {
		if (!messaging) {
			throw new Error('Firebase messaging not initialized');
		}

		if (!device.token) {
			logger.info(
				`Device ${device.deviceId} for authority ${notification.authorityId} does not have a token`
			);
			return;
		}

		try {
			const message = {
				notification: {
					title: notification.title,
					body: notification.body,
				},
				token: device.token,
			};

			await limiter.schedule(() => messaging!.send(message));

			logger.info(
				`Successfully sent notification to device ${device.deviceId} for authority ${notification.authorityId} via Firebase`
			);
		} catch (error) {
			const firebaseError = error as { code?: string; message: string };

			if (
				firebaseError.code === 'messaging/invalid-registration-token' ||
				firebaseError.code === 'messaging/registration-token-not-registered'
			) {
				logger.warn(`Invalid token for device ${device.deviceId} - Removing device`);
				try {
					await removeDevice({
						authorityId: notification.authorityId,
						deviceId: device.deviceId,
					});
				} catch (removeError) {
					logger.error(
						`Failed to remove invalid device ${device.deviceId}: ${removeError}`
					);
				}
			} else {
				logger.error(
					`Error sending notification to device ${device.deviceId} via Firebase: ${firebaseError.message}`
				);
			}

			throw error;
		}
	};

	return {
		id: 'firebase',
		isEnabled,
		canHandle: (notification: NotificationRecord): boolean => {
			return (
				Boolean(notification.authorityId) &&
				Boolean(notification.channels?.includes(NotificationChannel.PUSH))
			);
		},
		sendNotification: async (notification: NotificationRecord): Promise<void> => {
			if (!messaging) {
				throw new Error('Firebase messaging not initialized');
			}

			const preferences = await getPreferences(notification.authorityId);
			if (notification.type && preferences?.pushOptOutTypes?.includes(notification.type)) {
				logger.info(
					`Skipping push notification "${notification.title}" for authority ${notification.authorityId} due to preference opt-out`
				);
				return;
			}

			const devices = await getDevices(notification.authorityId);

			if (devices.length === 0) {
				logger.info(`No active devices found for authority ${notification.authorityId}`);
				return;
			}

			logger.info(
				`Sending Firebase notification to ${devices.length} devices for authority ${notification.authorityId}`
			);

			const results = await Promise.allSettled(
				devices.map((device) => sendToDevice(notification, device))
			);

			const successes = results.filter((r) => r.status === 'fulfilled').length;
			const failures = results.filter((r) => r.status === 'rejected').length;

			logger.info(
				`Firebase notification results for authority ${notification.authorityId}: ${successes} successes, ${failures} failures`
			);

			if (failures === devices.length && devices.length > 0) {
				throw new Error(
					`Failed to send Firebase notification to all devices for authority ${notification.authorityId}`
				);
			}
		},
	};
};
