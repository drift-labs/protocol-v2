import { BaseDynamoRecord, RecordTypes, SettlePnlRecord } from '@backend/common';
import { DynamoDB, getBaseRecordFields, getRecordKeys, SETTLE_PNL_RECORD_ID, USER_PK } from '..';

export const SettlePnlRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createSettlePnlRecords = async (settlePnlRecords: SettlePnlRecord[]) => {
		const records = settlePnlRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.SettlePnlRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getSettlePnlRecords = async ({
		id,
		page = undefined,
	}: {
		id: string;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (SettlePnlRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			sk: SETTLE_PNL_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (SettlePnlRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getSettlePnlRecordsBetweenTimestamps = async ({
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
		records: (SettlePnlRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${SETTLE_PNL_RECORD_ID}#TS#${startTs}`,
				':endSk': `${SETTLE_PNL_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (SettlePnlRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getSettlePnlRecords,
		getSettlePnlRecordsBetweenTimestamps,
		createSettlePnlRecords,
	};
};
