import { BaseDynamoRecord, LPRecord, RecordTypes } from '@backend/common';
import { DynamoDB, getBaseRecordFields, getRecordKeys, LP_RECORD_ID, USER_PK } from '..';

export const LPRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createLPRecords = async (lPRecords: LPRecord[]) => {
		const records = lPRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.LPRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getLPRecords = async ({
		id,
		page = undefined,
	}: {
		id: string;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (LPRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			sk: LP_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (LPRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getLPRecordsBetweenTimestamps = async ({
		id,
		startTs,
		endTs,
		page = undefined,
	}: {
		id: string;
		startTs: number;
		endTs: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (LPRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${LP_RECORD_ID}#TS#${startTs}`,
				':endSk': `${LP_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (LPRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getLPRecords,
		getLPRecordsBetweenTimestamps,
		createLPRecords,
	};
};
