import {
	getTimestamp,
	logger,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
} from '@backend/common';
import { AlertRepository, DynamoDB, NotificationRepository } from '@backend/dynamodb';
import { OraclePriceData } from '../types';
import { getNotificationBody, getNotificationTitle } from '../utils';

export const PriceProcessor = () => {
	const { checkPriceRange } = AlertRepository();
	const { batchWrite } = DynamoDB();
	const { createNotifications } = NotificationRepository();

	const processPriceUpdate = async (data: OraclePriceData): Promise<void> => {
		const { symbol, price, priceChange } = data;

		logger.info(`Processing price update for ${symbol}: ${price}, change: ${priceChange}`);

		const direction = priceChange > 0 ? 'ABOVE' : 'BELOW';
		const currentPrice = price;
		const timestamp = getTimestamp();

		const min = direction === 'ABOVE' ? currentPrice - Math.abs(priceChange) : currentPrice;

		const max = direction === 'ABOVE' ? currentPrice : currentPrice + Math.abs(priceChange);

		const alerts = await checkPriceRange({
			symbol,
			direction,
			min: min.toString(),
			max: max.toString(),
		});

		if (alerts.length > 0) {
			// TODO: Potentially apply some checks here to make sure that the alert hasn't been recently triggered?
			const notifications = alerts.map((alert) => ({
				authorityId: alert.authorityId,
				type: NotificationType.PRICE_ALERT,
				status: NotificationStatus.PENDING,
				title: getNotificationTitle(),
				body: getNotificationBody(),
				channels: [NotificationChannel.APP, NotificationChannel.PUSH],
				data: {
					symbol: alert.symbol,
					targetPrice: alert.targetPrice,
					triggeredAt: timestamp,
					direction: alert.direction,
				},
			}));

			const alertUpdates = alerts.map((alert) => ({
				...alert,
				lastTriggeredAt: timestamp,
				GSI1PK: `TRIGGERED#${alert.GSI1PK}`,
			}));

			logger.info(`Processing ${notifications.length} alerts/notifications`);

			// TODO - Handle errors
			await Promise.all([
				createNotifications(notifications),
				batchWrite({ records: alertUpdates }),
			]);

			logger.info(
				`Successfully processed ${notifications.length} alerts for ${symbol} at ${currentPrice}`
			);
		}
	};

	return {
		processPriceUpdate,
	};
};
