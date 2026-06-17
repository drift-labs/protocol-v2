import {
	BaseDynamoRecord,
	getTimestamp,
	NotificationPreferencesRecord,
	NotificationRecord,
	NotificationStatus,
	NotificationType,
	RecordTypes,
	SecondaryIndex,
} from '@backend/common';
import { v7 as uuidv7 } from 'uuid';
import { DynamoDB } from '../client';
import { getBaseRecordFields, getRecordKeys, getTTLTimestampForNotification } from '../utils';

export const NotificationRepository = () => {
	const { batchWrite, query, get, transact, update } = DynamoDB();

	const createNotifications = async (
		notificationRecords: Omit<NotificationRecord, 'notificationId'>[],
		options: { ttlSeconds?: number } = {}
	) => {
		const records = notificationRecords.map((record) => {
			const recordWithId = {
				...record,
				notificationId: uuidv7(),
			};
			const defaults = {
				...getRecordKeys(recordWithId, RecordTypes.NotificationRecord),
				...recordWithId,
				...getBaseRecordFields(recordWithId),
				...getTTLTimestampForNotification(),
			};
			if (options.ttlSeconds !== undefined) {
				defaults.ttl = Math.floor(Date.now() / 1000) + options.ttlSeconds;
			}
			return defaults;
		});

		return batchWrite({ records });
	};

	const getNotifications = async ({
		authorityId,
		status,
		page = undefined,
	}: {
		authorityId: string;
		status: NotificationStatus;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (NotificationRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `AUTHORITY#${authorityId}`,
			sk: `NOTIFICATION#STATUS#${status ?? ''}`,
			lastEvaluatedKey: page,
		});

		const records = Items as (NotificationRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getLastNotificationByType = async ({
		authorityId,
		type,
	}: {
		authorityId: string;
		type: NotificationType;
	}): Promise<NotificationRecord & BaseDynamoRecord> => {
		const { Items = [] } = await query({
			pk: `AUTHORITY#${authorityId}`,
			sk: `NOTIFICATION#TYPE#${type}`,
			limit: 1,
			secondaryIndex: SecondaryIndex.GSI1,
		});

		return Items[0] as NotificationRecord & BaseDynamoRecord;
	};

	const updateNotificationStatus = async ({
		authorityId,
		notificationId,
		status = NotificationStatus.READ,
	}: {
		authorityId: string;
		notificationId: string;
		status?: NotificationStatus;
	}): Promise<void> => {
		const { pk, sk } = getRecordKeys(
			{ authorityId, notificationId, status: NotificationStatus.PENDING },
			RecordTypes.NotificationRecord
		);

		const { Item: existingItem = null } = await get({ pk, sk });

		if (!existingItem) {
			throw Error(`Notification: ${notificationId} does not exist`);
		}

		const newItem = {
			...existingItem,
			sk: `NOTIFICATION#STATUS#${status}#${notificationId}`,
			status: status,
			updatedAt: Date.now(),
			...(status === NotificationStatus.SENT ? { sentAt: getTimestamp() } : {}),
		};

		await transact({
			items: [
				{
					Put: {
						Item: newItem,
					},
				},
				{
					Delete: {
						Key: {
							pk: existingItem.pk,
							sk: existingItem.sk,
						},
					},
				},
			],
		});
	};

	const getPreferences = async (
		authorityId: string
	): Promise<NotificationPreferencesRecord | null> => {
		const { pk, sk } = getRecordKeys(
			{ authorityId } as NotificationPreferencesRecord,
			RecordTypes.NotificationPreferencesRecord
		);

		const { Item = null } = await get({ pk, sk });
		return Item ? (Item as NotificationPreferencesRecord) : null;
	};

	const upsertPreferences = async ({
		authorityId,
		pushOptOutTypes,
	}: NotificationPreferencesRecord): Promise<NotificationPreferencesRecord> => {
		const result = await update({
			...getRecordKeys(
				{ authorityId } as NotificationPreferencesRecord,
				RecordTypes.NotificationPreferencesRecord
			),
			updateExpression:
				'SET authorityId = :authorityId, pushOptOutTypes = :pushOptOutTypes, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)',
			expressionValues: {
				':authorityId': authorityId,
				':pushOptOutTypes': pushOptOutTypes,
				':updatedAt': getTimestamp(),
				':createdAt': getTimestamp(),
			},
		});

		return result.Attributes as NotificationPreferencesRecord;
	};

	return {
		createNotifications,
		getNotifications,
		getLastNotificationByType,
		updateNotificationStatus,
		getPreferences,
		upsertPreferences,
	};
};
