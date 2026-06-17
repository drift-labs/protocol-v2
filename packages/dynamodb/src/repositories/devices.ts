import { DeviceRecord, getTimestamp, RecordTypes } from '@backend/common';
import { DynamoDB } from '../client';
import { getRecordKeys, getTTLTimestampForDelete } from '../utils';

export const DeviceRepository = () => {
	const { update, query } = DynamoDB();

	const upsertDevice = async (deviceRecord: DeviceRecord): Promise<DeviceRecord> => {
		await update({
			...getRecordKeys(deviceRecord, RecordTypes.DeviceRecord),
			updateExpression:
				'SET #token = :token, platform = :platform, authorityId = :authorityId, deviceId = :deviceId, updatedAt = :updatedAt, active = :active, createdAt = if_not_exists(createdAt, :createdAt)',
			expressionNames: {
				'#token': 'token',
			},
			expressionValues: {
				':token': deviceRecord.token ?? '',
				':platform': deviceRecord.platform ?? '',
				':authorityId': deviceRecord.authorityId,
				':deviceId': deviceRecord.deviceId,
				':active': true,
				':updatedAt': getTimestamp(),
				':createdAt': getTimestamp(),
			},
		});

		return deviceRecord;
	};

	const getDevices = async (authorityId: string): Promise<DeviceRecord[]> => {
		const result = await query({
			pk: `AUTHORITY#${authorityId}`,
			sk: 'DEVICE#',
			expression: 'pk = :pk and begins_with(sk, :sk)',
			filterExpression: 'active = :active',
			expressionValues: {
				':pk': `AUTHORITY#${authorityId}`,
				':sk': 'DEVICE#',
				':active': true,
			},
		});

		return result.Items as DeviceRecord[];
	};

	const removeDevice = async ({
		authorityId,
		deviceId,
	}: Pick<DeviceRecord, 'authorityId' | 'deviceId'>): Promise<void> => {
		await update({
			...getRecordKeys({ authorityId, deviceId }, RecordTypes.DeviceRecord),
			updateExpression: 'SET updatedAt = :updatedAt, active = :active, #ttl = :ttl',
			expressionNames: {
				'#ttl': 'ttl',
			},
			expressionValues: {
				':active': false,
				':updatedAt': getTimestamp(),
				':ttl': getTTLTimestampForDelete(),
			},
		});
	};

	return {
		upsertDevice,
		getDevices,
		removeDevice,
	};
};
