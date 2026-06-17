import { BaseDynamoRecord, InsuranceFundRecord, RecordTypes } from '@backend/common';
import {
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	INSURANCE_FUND_RECORD_ID,
	MARKET_PK,
} from '..';

export const InsuranceFundRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createInsuranceFundRecords = async (insuranceFundRecords: InsuranceFundRecord[]) => {
		const records = insuranceFundRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.InsuranceFundRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getInsuranceFundRecords = async ({
		id,
		page = undefined,
	}: {
		id: string;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (InsuranceFundRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${MARKET_PK}#${id}`,
			sk: `${INSURANCE_FUND_RECORD_ID}#`,
			lastEvaluatedKey: page,
		});

		const records = Items as (InsuranceFundRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getInsuranceFundRecordsBetweenTimestamps = async ({
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
		records: (InsuranceFundRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${MARKET_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${MARKET_PK}#${id}`,
				':startSk': `${INSURANCE_FUND_RECORD_ID}#TS#${startTs}`,
				':endSk': `${INSURANCE_FUND_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (InsuranceFundRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getInsuranceFundRecords,
		getInsuranceFundRecordsBetweenTimestamps,
		createInsuranceFundRecords,
	};
};
