import {
	BaseDynamoRecord,
	DBRecord,
	DEFAULT_ENDPOINT,
	getOrderLabel,
	getTimestamp,
	isFeatureEnabled,
	isOrderFullyFilled,
	LiquidationRecord,
	logger,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
	RecordTypes,
	TradeRecord,
} from '@backend/common';
import {
	authorityMapKeys,
	DynamoDB,
	LIQUIDATION_RECORD_ID,
	NotificationRepository,
	OrderRepository,
	PREDICTION_RECORD_ID,
	TRADE_RECORD_ID,
} from '@backend/dynamodb';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeUser, PRICE_PRECISION_EXP } from '@velocity-exchange/sdk';
import Decimal from 'decimal.js';
import {
	checkNotificationAge,
	checkNotificationCooldown,
	getIsolatedPositionLiquidationAlertBody,
	getIsolatedPositionLiquidationAlertTitle,
	getLiquidationAlertBody,
	getLiquidationAlertTitle,
	getOrderFillNotificationBody,
	getOrderFillNotificationTitle,
} from '../utils';

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'confirmed');

const NOTIFICATION_COOLDOWN_SECONDS = parseInt(
	process.env.NOTIFICATION_COOLDOWN_SECONDS || '600',
	10
);

const MAX_RECORD_AGE_SECONDS = parseInt(process.env.MAX_RECORD_AGE_SECONDS || '600', 10);

export const RecordProcessor = () => {
	const { get, put } = DynamoDB();
	const { getOrderRecordById } = OrderRepository();
	const { createNotifications } = NotificationRepository();

	const getTradeRecordNotificationWhitelist = () =>
		(process.env.TRADE_RECORD_NOTIFICATION_WHITELIST || '')
			.split(',')
			.map((wallet) => wallet.trim())
			.filter(Boolean);

	const getRecordTypeFromSk = (sk: string): RecordTypes | null => {
		if (sk.startsWith(`${TRADE_RECORD_ID}#`)) return RecordTypes.TradeRecord;
		if (sk.startsWith(`${PREDICTION_RECORD_ID}#`)) return RecordTypes.PredictionRecord;
		if (sk.startsWith(`${LIQUIDATION_RECORD_ID}#`)) return RecordTypes.LiquidationRecord;
		return null;
	};

	const getAuthority = async (user: string) => {
		const { Item: authorityMap } = await get(authorityMapKeys(user));

		if (!authorityMap) {
			const publicKey = new PublicKey(user);
			const accountInfo = await connection.getAccountInfo(publicKey);

			if (!accountInfo) {
				throw Error(`User could not be found for ${publicKey}`);
			}

			const userBuffer = accountInfo.data;
			const decodedUser = decodeUser(userBuffer);
			const authority = decodedUser.authority.toString();

			try {
				await put({
					record: {
						...authorityMapKeys(user),
						authority,
					},
				});
			} catch {
				// ignore
			}

			return authority;
		}

		return authorityMap.authority;
	};

	const processRecord = async (data: DBRecord & BaseDynamoRecord): Promise<void> => {
		const { pk, sk, ts } = data;

		if (!sk) {
			logger.info('Skipping record with missing sk field');
			return;
		}

		if (checkNotificationAge(ts, MAX_RECORD_AGE_SECONDS)) {
			logger.info(`Skipping record processing: Record too old, pk: ${pk}, sk: ${sk}}`);
			return;
		}

		const recordType = getRecordTypeFromSk(sk);

		if (!recordType) {
			logger.info(`Skipping unsupported record type: ${sk}`);
			return;
		}

		switch (recordType) {
			case RecordTypes.TradeRecord:
			case RecordTypes.PredictionRecord: {
				const record = data as TradeRecord;
				const {
					action,
					symbol,
					user,
					userOrderId,
					taker,
					takerOrderDirection,
					takerOrderCumulativeBaseAssetAmountFilled,
					takerOrderCumulativeQuoteAssetAmountFilled,
					makerOrderDirection,
					makerOrderCumulativeBaseAssetAmountFilled,
					makerOrderCumulativeQuoteAssetAmountFilled,
				} = record;
				const tradeRecordNotificationWhitelist = getTradeRecordNotificationWhitelist();
				const isTradeRecordNotificationsEnabled = isFeatureEnabled(
					'TRADE_RECORD_NOTIFICATIONS'
				);
				const isWhitelistedUser = tradeRecordNotificationWhitelist.includes(user ?? '');

				if (!isTradeRecordNotificationsEnabled && !isWhitelistedUser) {
					logger.info(
						'Skipping trade record notification processing: feature disabled and user not whitelisted'
					);
					return;
				}

				if (tradeRecordNotificationWhitelist.length > 0 && !isWhitelistedUser) {
					logger.info(
						`Skipping trade record notification processing: user ${user} not in whitelist`
					);
					return;
				}

				logger.info(`Processing ${action} record for ${symbol}, user: ${user}`);

				if (!user) {
					throw Error(`User not found in record: ${JSON.stringify(record)}`);
				}

				if (!isOrderFullyFilled(record)) {
					logger.info(
						`Order not fully filled for user: ${user}, userOrderId: ${userOrderId}`
					);
					return;
				}

				const order = await getOrderRecordById({
					user,
					orderId: userOrderId!,
				});

				if (!order) {
					throw Error(`Order not found for user: ${user}, userOrderId: ${userOrderId}`);
				}

				const orderType = getOrderLabel(order);

				if (!orderType) {
					logger.info(
						`Skipping unsupported filled order for user: ${user}, userOrderId: ${userOrderId}`
					);
					return;
				}

				const authority = await getAuthority(user);
				const key = taker === user ? 'taker' : 'maker';
				const userDirection = key === 'taker' ? takerOrderDirection : makerOrderDirection;
				const userSize =
					key === 'taker'
						? takerOrderCumulativeBaseAssetAmountFilled
						: makerOrderCumulativeBaseAssetAmountFilled;
				const userQuoteFilled =
					key === 'taker'
						? takerOrderCumulativeQuoteAssetAmountFilled
						: makerOrderCumulativeQuoteAssetAmountFilled;
				const price = Number(
					new Decimal(userQuoteFilled)
						.dividedBy(new Decimal(userSize))
						.toFixed(PRICE_PRECISION_EXP.toNumber())
				);

				await createNotifications([
					{
						authorityId: authority,
						user,
						type: NotificationType.RECORD_UPDATE,
						status: NotificationStatus.PENDING,
						title: getOrderFillNotificationTitle(orderType),
						body: getOrderFillNotificationBody({
							orderType,
							size: userSize,
							symbol,
							price,
						}),
						channels: [NotificationChannel.APP, NotificationChannel.PUSH],
						data: {
							symbol,
							direction: userDirection.toUpperCase(),
							orderType,
							size: userSize,
							price,
							recordType,
						},
						createdAt: getTimestamp(),
					},
				]);

				logger.info(
					`Successfully processed ${orderType} order fill: ${symbol}, authority: ${authority} user: ${user}, orderId: ${userOrderId}`
				);

				break;
			}

			case RecordTypes.LiquidationRecord: {
				const record = data as LiquidationRecord;
				logger.info(`Processing liquidation record for user: ${record.user}`);

				if (!record.user) {
					throw Error(`User not found in record: ${JSON.stringify(record)}`);
				}

				const authority = await getAuthority(record.user);
				const inCooldown = await checkNotificationCooldown(
					authority,
					NotificationType.RECORD_UPDATE,
					NOTIFICATION_COOLDOWN_SECONDS
				);

				const isIsolatedPosition = (record.bitFlags & 1) > 0;

				if (!inCooldown) {
					await createNotifications([
						{
							authorityId: authority,
							user: record.user,
							type: NotificationType.RECORD_UPDATE,
							status: NotificationStatus.PENDING,
							title: isIsolatedPosition
								? getIsolatedPositionLiquidationAlertTitle()
								: getLiquidationAlertTitle(),
							body: isIsolatedPosition
								? getIsolatedPositionLiquidationAlertBody()
								: getLiquidationAlertBody(),
							channels: [NotificationChannel.APP, NotificationChannel.PUSH],
							createdAt: getTimestamp(),
							data: {
								recordType,
							},
							actions: [
								{
									label: 'View your account',
									link: `https://app.drift.trade/overview`,
								},
							],
						},
					]);
				}

				logger.info(
					`Successfully processed liquidation alert for authority: ${authority}, user: ${record.user}`
				);
				break;
			}

			default:
				logger.warn(`Unhandled record type: ${recordType}, ${JSON.stringify(data)}`);
		}
	};

	return {
		processRecord,
	};
};
