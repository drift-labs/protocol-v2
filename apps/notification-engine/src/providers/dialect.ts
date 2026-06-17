import {
	logger,
	NotificationChannel,
	NotificationRecord,
	NotificationType,
	RecordTypes,
} from '@backend/common';
import {
	NodeDialectSolanaWalletAdapter,
	Solana,
	SolanaSdkFactory,
} from '@dialectlabs/blockchain-sdk-solana';
import {
	Dapp,
	Dialect,
	DialectCloudEnvironment,
	NotificationType as DialectNotificationType,
	DialectSdk,
	SendDappMessageCommand,
} from '@dialectlabs/sdk';
import { NotificationProvider } from '../types';

export const DialectProvider = (): NotificationProvider => {
	const DEFAULT_DIALECT_NOTIFICATION_TYPE_ID = process.env.DEFAULT_DIALECT_NOTIFICATION_TYPE_ID;

	let dialectSdk: DialectSdk<Solana> | null = null;
	let dialectDapp: Dapp | null = null;
	let dialectNotificationTypeMap: DialectNotificationType[] | undefined = undefined;

	const initializeDialect = () => {
		if (!dialectSdk) {
			const environment: DialectCloudEnvironment =
				(process.env.DIALECT_ENVIRONMENT as DialectCloudEnvironment) || 'development';

			dialectSdk = Dialect.sdk(
				{
					environment,
				},
				SolanaSdkFactory.create({
					wallet: NodeDialectSolanaWalletAdapter.create(),
				})
			);

			logger.info('Dialect notification provider initialized');
		}

		return dialectSdk;
	};

	const getDapp = async (): Promise<any> => {
		if (!dialectDapp) {
			const sdk = initializeDialect();
			dialectDapp = await sdk.dapps.find();
			dialectNotificationTypeMap = await dialectDapp?.notificationTypes.findAll();
			if (!dialectDapp) {
				throw new Error('Unable to find dialect dapp');
			}
		}

		return dialectDapp;
	};

	const getNotificationType = (notification: NotificationRecord) => {
		const { type, data } = notification;
		let humanReadableId = '';

		if (type === NotificationType.ACCOUNT_UPDATE) {
			humanReadableId = 'liquidation-warning';
		}

		if (
			type === NotificationType.RECORD_UPDATE &&
			data.recordType == RecordTypes.LiquidationRecord
		) {
			humanReadableId = 'liquidation-alert';
		}

		const dialectType = dialectNotificationTypeMap?.find(
			(type) => type.humanReadableId === humanReadableId
		);

		if (dialectType) {
			return dialectType.id;
		}

		return DEFAULT_DIALECT_NOTIFICATION_TYPE_ID;
	};

	return {
		id: 'dialect',
		isEnabled: (): boolean => {
			const enabled = Boolean(process.env.DIALECT_SDK_CREDENTIALS);
			return enabled;
		},
		canHandle: (notification: NotificationRecord): boolean => {
			return (
				Boolean(notification.authorityId) &&
				Boolean(notification.channels?.includes(NotificationChannel.APP))
			);
		},
		sendNotification: async (notification: NotificationRecord): Promise<void> => {
			try {
				const dapp = await getDapp();

				// NO ACTIONS FOR NOW
				// const actionsV2: DappMessageLinksAction = notification.actions
				// 	? {
				// 			type: DappMessageActionType.LINK,
				// 			links: [
				// 				{
				// 					label: notification.actions[0].label,
				// 					url: notification.actions[0].link,
				// 				},
				// 			],
				// 	  }
				// 	: {
				// 			type: DappMessageActionType.LINK,
				// 			links: [
				// 				{
				// 					label: 'View Details',
				// 					url: 'https://app.drift.trade',
				// 				},
				// 			],
				// 	  };

				const sendParams: SendDappMessageCommand = {
					title: notification.title,
					message: notification.body,
					recipient: notification.authorityId,
					notificationTypeId: getNotificationType(notification),
				};

				await dapp.messages.send(sendParams);

				logger.info(
					`Successfully sent notification to ${notification.user} for authority ${notification.authorityId} via Dialect`
				);
			} catch (error) {
				const { message } = error as Error;
				logger.error(
					`Error sending Dialect notification to ${notification.user} for authority ${notification.authorityId}: ${message}`
				);
				throw error;
			}
		},
	};
};
