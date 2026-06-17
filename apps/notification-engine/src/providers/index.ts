import { logger, NotificationRecord, NotificationStatus } from '@backend/common';
import { NotificationRepository } from '@backend/dynamodb';
import { NotificationProvider } from '../types';
import { DialectProvider } from './dialect';
import { FirebaseProvider } from './firebase';
import { RedisProvider } from './redis';

const notificationProviders: NotificationProvider[] = [];
let whitelistedAddresses: string[] = [];

export const registerWhitelist = () => {
	const whitelist = process.env.NOTIFICATION_WHITELIST_AUTHORITIES || '';
	whitelistedAddresses = whitelist
		.split(',')
		.map((addr) => addr.trim())
		.filter(Boolean);
	logger.info(
		`Loaded ${whitelistedAddresses.length} whitelisted addresses for notifications in dry-run mode`
	);
};

export const isLiveSendingEnabled = (): boolean => {
	return process.env.NOTIFICATION_SENDING_ENABLED === 'true';
};

export const isWhitelistedAddress = (authorityId: string): boolean => {
	return whitelistedAddresses.includes(authorityId);
};

export const registerProvider = (provider: NotificationProvider): void => {
	registerWhitelist();
	notificationProviders.push(provider);
	logger.info(`Registered notification provider: ${provider.id}`);
};

export const resetRegistry = () => {
	notificationProviders.splice(0);
};

export const getEnabledProviders = (): NotificationProvider[] => {
	return notificationProviders.filter((provider) => provider.isEnabled());
};

export const getProvidersForNotification = (
	notification: NotificationRecord
): NotificationProvider[] => {
	return getEnabledProviders().filter((provider) => provider.canHandle(notification));
};

export const registerAllProviders = (): void => {
	registerProvider(FirebaseProvider());
	registerProvider(DialectProvider());
	registerProvider(RedisProvider());
};

export const processNotification = async (notification: NotificationRecord): Promise<void> => {
	const { updateNotificationStatus } = NotificationRepository();

	const providers = getProvidersForNotification(notification);
	const isLive = isLiveSendingEnabled();
	const isWhitelisted = isWhitelistedAddress(notification.authorityId);
	const shouldSend = isLive || isWhitelisted;

	if (!shouldSend) {
		logger.info(
			`[DRY RUN] Would process notification "${notification.title}" for authority ${
				notification.authorityId
			} with ${providers.length} providers: ${providers.map((p) => p.id).join(', ')}`
		);

		try {
			await updateNotificationStatus({
				authorityId: notification.authorityId,
				notificationId: notification.notificationId,
				status: NotificationStatus.SENT,
			});
		} catch (error) {
			logger.error(`Failed to update notification status: ${error.message}`);
		}

		return;
	}

	if (providers.length === 0) {
		logger.warn(
			`No enabled providers can handle notification for authority ${notification.authorityId}`
		);
		return;
	}

	if (!isLive && isWhitelisted) {
		logger.info(
			`[WHITELISTED DRY RUN] Processing notification for whitelisted authority ${notification.authorityId} with ${providers.length} providers`
		);
	} else {
		logger.info(
			`Processing notification for authority ${notification.authorityId} with ${providers.length} providers`
		);
	}

	const results = await Promise.allSettled(
		providers.map((provider) => provider.sendNotification(notification))
	);

	const successes = results.filter((r) => r.status === 'fulfilled').length;
	const failures = results.filter((r) => r.status === 'rejected').length;

	logger.info(
		`Notification results for authority ${notification.authorityId}: ${successes} providers succeeded, ${failures} providers failed`
	);

	if (successes > 0) {
		try {
			await updateNotificationStatus({
				authorityId: notification.authorityId,
				notificationId: notification.notificationId,
				status: NotificationStatus.SENT,
			});
		} catch (error) {
			logger.error(`Failed to update notification status: ${error.message}`);
		}
	}

	if (failures === providers.length) {
		throw new Error(
			`All notification providers failed for authority ${notification.authorityId}`
		);
	}
};
