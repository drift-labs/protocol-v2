import {
	DEFAULT_ENDPOINT,
	logger,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
	RiskBucket,
} from '@backend/common';
import { NotificationRepository } from '@backend/dynamodb';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { VelocityClient, VelocityEnv, Wallet } from '@velocity-exchange/sdk';
import { RiskManager } from '../services/risk-manager';
import { RiskNotification } from '../types';
import {
	checkNotificationAge,
	checkNotificationCooldown,
	getLiquidationWarningBody,
	getLiquidationWarningTitle,
} from '../utils';

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'confirmed');
const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;

const driftClient = new VelocityClient({
	env: driftEnv,
	connection,
	wallet: new Wallet(new Keypair()),
});

const MAX_NOTIFICATION_AGE_SECONDS = parseInt(
	process.env.MAX_NOTIFICATION_AGE_SECONDS || '600',
	10
);

const NOTIFICATION_COOLDOWN_SECONDS = parseInt(
	process.env.NOTIFICATION_COOLDOWN_SECONDS || '14400',
	10
);

export const AccountProcessor = () => {
	const { createNotifications } = NotificationRepository();
	const { createUserAccountFromBuffer, determineRiskBucket } = RiskManager();

	const processAccount = async (data: RiskNotification): Promise<void> => {
		const { user, oldBucket, newBucket, healthRatio, timestamp } = data;

		if (checkNotificationAge(timestamp, MAX_NOTIFICATION_AGE_SECONDS)) {
			logger.info(`Skipping notification for user ${user}: notification too old.`);
			return;
		}

		if (!driftClient._isSubscribed) {
			await driftClient.subscribe();
		}

		const publicKey = new PublicKey(user);
		const accountInfo = await connection.getAccountInfo(publicKey);

		if (!accountInfo || !accountInfo.data) {
			throw Error(`Unable to find user account: ${publicKey}`);
		}

		const userAccount = await createUserAccountFromBuffer(
			driftClient,
			user,
			accountInfo.data.toString('base64')
		);

		const riskBucket = determineRiskBucket(userAccount.getHealth());

		if (riskBucket !== RiskBucket.CRITICAL) {
			logger.warn(`User: ${user} is not in the correct risk bucket, bucket: ${riskBucket}`);
			return;
		}

		const authorityId = userAccount.getUserAccount().authority.toString();

		const inCooldown = await checkNotificationCooldown(
			authorityId,
			NotificationType.ACCOUNT_UPDATE,
			NOTIFICATION_COOLDOWN_SECONDS
		);

		if (!inCooldown) {
			await createNotifications([
				{
					authorityId,
					user,
					type: NotificationType.ACCOUNT_UPDATE,
					status: NotificationStatus.PENDING,
					title: getLiquidationWarningTitle(),
					body: getLiquidationWarningBody(),
					channels: [NotificationChannel.APP, NotificationChannel.PUSH],
					data: {
						newBucket,
						oldBucket,
						healthRatio,
					},
					actions: [
						{
							label: 'Deposit collateral',
							link: `https://app.drift.trade/`,
						},
					],
				},
			]);
		}

		logger.info(
			`Successfully processed liquidation warning: authority: ${authorityId} user: ${user}, bucket: ${newBucket}`
		);
	};

	return {
		processAccount,
	};
};
