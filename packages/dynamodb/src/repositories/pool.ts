import { BaseDynamoRecord, EntityTypes, LPMintRedeemRecord, RecordTypes } from '@backend/common';
import {
	AUTHORITY_PK,
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	LP_MINT_REDEEM_RECORD_ID,
	POOL_PK,
} from '..';

export const PoolRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createLPMintRedeemRecords = async (lPMintRedeemRecords: LPMintRedeemRecord[]) => {
		const records = lPMintRedeemRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.LPMintRedeemRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getLPMintRedeemRecords = async ({
		id,
		entity = EntityTypes.Authority,
		page = undefined,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (LPMintRedeemRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.Authority ? AUTHORITY_PK : POOL_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: LP_MINT_REDEEM_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (LPMintRedeemRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getLPMintRedeemRecordsBetweenTimestamps = async ({
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
		records: (LPMintRedeemRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.Authority ? AUTHORITY_PK : POOL_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${pk}#${id}`,
				':startSk': `${LP_MINT_REDEEM_RECORD_ID}#TS#${startTs}`,
				':endSk': `${LP_MINT_REDEEM_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (LPMintRedeemRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getLPMintRedeemRecords,
		getLPMintRedeemRecordsBetweenTimestamps,
		createLPMintRedeemRecords,
	};
};
