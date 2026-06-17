import { BaseDynamoRecord, FundingPaymentRecord, RecordTypes } from '@backend/common';
import {
	DynamoDB,
	FUNDING_PAYMENT_RECORD_ID,
	getBaseRecordFields,
	getRecordKeys,
	USER_PK,
} from '..';

export const FundingPaymentRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createFundingPaymentRecords = async (fundingPaymentRecords: FundingPaymentRecord[]) => {
		const records = fundingPaymentRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.FundingPaymentRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getFundingPaymentRecords = async ({
		id,
		page = undefined,
	}: {
		id: string;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (FundingPaymentRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			sk: FUNDING_PAYMENT_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (FundingPaymentRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getFundingPaymentRecordsBetweenTimestamps = async ({
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
		records: (FundingPaymentRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${FUNDING_PAYMENT_RECORD_ID}#TS#${startTs}`,
				':endSk': `${FUNDING_PAYMENT_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (FundingPaymentRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getFundingPaymentRecords,
		getFundingPaymentRecordsBetweenTimestamps,
		createFundingPaymentRecords,
	};
};
