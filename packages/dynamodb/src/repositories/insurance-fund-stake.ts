import {
	BaseDynamoRecord,
	EntityTypes,
	InsuranceFundStakeRecord,
	RecordTypes,
} from '@backend/common';
import {
	AUTHORITY_PK,
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	INSURANCE_FUND_STAKE_RECORD_ID,
	MARKET_PK,
} from '..';

export const InsuranceFundStakeRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createInsuranceFundStakeRecords = async (
		insuranceFundStakeRecords: InsuranceFundStakeRecord[]
	) => {
		const records = insuranceFundStakeRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.InsuranceFundStakeRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getInsuranceFundStakeRecords = async ({
		id,
		entity = EntityTypes.Authority,
		page = undefined,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (InsuranceFundStakeRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.Authority ? AUTHORITY_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: INSURANCE_FUND_STAKE_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (InsuranceFundStakeRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getInsuranceFundStakeRecordsBetweenTimestamps = async ({
		id,
		startTs,
		endTs,
		entity = EntityTypes.Authority,
		page = undefined,
	}: {
		id: string;
		startTs: number;
		endTs: number;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (InsuranceFundStakeRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.Authority ? AUTHORITY_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${AUTHORITY_PK}#${id}`,
				':startSk': `${INSURANCE_FUND_STAKE_RECORD_ID}#TS#${startTs}`,
				':endSk': `${INSURANCE_FUND_STAKE_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (InsuranceFundStakeRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getInsuranceFundStakeRecords,
		getInsuranceFundStakeRecordsBetweenTimestamps,
		createInsuranceFundStakeRecords,
	};
};
