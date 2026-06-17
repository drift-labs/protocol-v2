import { BaseDynamoRecord, DepositRecord, EntityTypes, RecordTypes } from '@backend/common';
import {
	DEPOSIT_RECORD_ID,
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	MARKET_PK,
	USER_PK,
} from '..';

export const DepositRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createDepositRecords = async (depositRecords: DepositRecord[]) => {
		const records = depositRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.DepositRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getDepositRecords = async ({
		id,
		entity = EntityTypes.User,
		page = undefined,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (DepositRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: DEPOSIT_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (DepositRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getDepositRecordsBetweenTimestamps = async ({
		id,
		startTs,
		endTs,
		entity = EntityTypes.User,
		page = undefined,
	}: {
		id: string;
		startTs: number;
		endTs: number;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (DepositRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${DEPOSIT_RECORD_ID}#TS#${startTs}`,
				':endSk': `${DEPOSIT_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (DepositRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getDepositRecords,
		getDepositRecordsBetweenTimestamps,
		createDepositRecords,
	};
};
