import {
	AlertRecord,
	RecordKeys,
	RecordTypes,
	SecondaryIndex,
	getTimestamp,
} from '@backend/common';
import { v7 as uuidv7 } from 'uuid';
import { DynamoDB } from '../client';
import {
	getAlertRecordPrimaryKeys,
	getBaseRecordFields,
	getRecordKeys,
	getTTLTimestampForDelete,
} from '../utils';

export const AlertRepository = () => {
	const { update, query, queryAll, put } = DynamoDB();

	const createAlert = async (alertRecord: Omit<AlertRecord, 'alertId'>) => {
		const recordWithId = {
			...alertRecord,
			alertId: uuidv7(),
		};

		const record = {
			...getRecordKeys(recordWithId, RecordTypes.AlertRecord),
			...recordWithId,
			...getBaseRecordFields(recordWithId),
		};

		await put({ record });

		return record;
	};

	const getAlerts = async ({ authorityId }: { authorityId: string }): Promise<AlertRecord[]> => {
		const result = await query({
			pk: `AUTHORITY#${authorityId}`,
			sk: 'ALERT#',
			expression: 'pk = :pk and begins_with(sk, :sk)',
			filterExpression: 'active = :active',
			expressionValues: {
				':pk': `AUTHORITY#${authorityId}`,
				':sk': 'ALERT#',
				':active': true,
			},
		});

		return result.Items as AlertRecord[];
	};

	const removeAlert = async ({
		authorityId,
		alertId,
	}: Pick<AlertRecord, 'alertId' | 'authorityId'>): Promise<void> => {
		await update({
			...getAlertRecordPrimaryKeys({ authorityId, alertId }),
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

	const checkPriceRange = async (params: {
		symbol: string;
		direction: 'ABOVE' | 'BELOW';
		min: string;
		max: string;
	}): Promise<(AlertRecord & RecordKeys)[]> => {
		const { symbol, direction, min, max } = params;

		const result = await queryAll({
			pk: `${symbol}#${direction}`,
			expression: 'GSI1PK = :GSI1PK AND GSI1SK BETWEEN :min AND :max',
			filterExpression: '',
			expressionValues: {
				':GSI1PK': `ALERT#${symbol}#DIRECTION#${direction}`,
				':min': min,
				':max': max,
			},
			secondaryIndex: SecondaryIndex.GSI1,
		});

		return result as (AlertRecord & RecordKeys)[];
	};

	return {
		createAlert,
		getAlerts,
		removeAlert,
		checkPriceRange,
	};
};
