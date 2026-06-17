import { BaseDynamoRecord, FundingRateRecord, RecordTypes } from '@backend/common';
import {
	DynamoDB,
	FUNDING_RATE_RECORD_ID,
	getBaseRecordFields,
	getRecordKeys,
	MARKET_PK,
} from '..';

export const FundingRateRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createFundingRateRecords = async (fundingRateRecords: FundingRateRecord[]) => {
		const records = fundingRateRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.FundingRateRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getFundingRateRecords = async ({
		id,
		page = undefined,
		limit,
	}: {
		id: string;
		page?: Record<string, any> | undefined;
		limit?: number;
	}): Promise<{
		records: (FundingRateRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${MARKET_PK}#${id}`,
			sk: FUNDING_RATE_RECORD_ID,
			lastEvaluatedKey: page,
			limit,
		});

		const records = Items as (FundingRateRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getFundingRateRecordsBetweenTimestamps = async ({
		id,
		startTs,
		endTs,
		page = undefined,
		limit = 20,
	}: {
		id: string;
		startTs: number;
		endTs: number;
		page?: Record<string, any> | undefined;
		limit?: number;
	}): Promise<{
		records: (FundingRateRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${MARKET_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${MARKET_PK}#${id}`,
				':startSk': `${FUNDING_RATE_RECORD_ID}#TS#${startTs}`,
				':endSk': `${FUNDING_RATE_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
			limit,
		});

		const records = Items as (FundingRateRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getFundingRateRecords,
		getFundingRateRecordsBetweenTimestamps,
		createFundingRateRecords,
	};
};
