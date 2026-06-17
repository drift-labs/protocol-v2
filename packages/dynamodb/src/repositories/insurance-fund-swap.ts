import { BaseDynamoRecord, InsuranceFundSwapRecord, RecordTypes } from '@backend/common';
import { DynamoDB, getBaseRecordFields, getRecordKeys, INSURANCE_FUND_SWAP_RECORD_ID } from '..';

export const InsuranceFundSwapRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createInsuranceFundSwapRecords = async (
		insuranceFundSwapRecords: InsuranceFundSwapRecord[]
	) => {
		const records = insuranceFundSwapRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.InsuranceFundSwapRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getInsuranceFundSwapRecords = async ({
		page = undefined,
	}: {
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (InsuranceFundSwapRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = INSURANCE_FUND_SWAP_RECORD_ID;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk,
			sk: INSURANCE_FUND_SWAP_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (InsuranceFundSwapRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getInsuranceFundSwapRecordsBetweenTimestamps = async ({
		startTs,
		endTs,
		page = undefined,
	}: {
		startTs: number;
		endTs: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (InsuranceFundSwapRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = INSURANCE_FUND_SWAP_RECORD_ID;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: pk,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': pk,
				':startSk': `${INSURANCE_FUND_SWAP_RECORD_ID}#TS#${startTs}`,
				':endSk': `${INSURANCE_FUND_SWAP_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (InsuranceFundSwapRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getInsuranceFundSwapRecords,
		getInsuranceFundSwapRecordsBetweenTimestamps,
		createInsuranceFundSwapRecords,
	};
};
