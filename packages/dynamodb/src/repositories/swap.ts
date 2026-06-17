import { BaseDynamoRecord, EntityTypes, RecordTypes, SwapRecord } from '@backend/common';
import {
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	MARKET_PK,
	SWAP_RECORD_ID,
	USER_PK,
} from '..';

export const SwapRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createSwapRecords = async (swapRecords: SwapRecord[]) => {
		const records = swapRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.SwapRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getSwapRecords = async ({
		id,
		entity = EntityTypes.User,
		page = undefined,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (SwapRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: SWAP_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (SwapRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getSwapRecordsBetweenTimestamps = async ({
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
		records: (SwapRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${SWAP_RECORD_ID}#TS#${startTs}`,
				':endSk': `${SWAP_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (SwapRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getSwapRecords,
		getSwapRecordsBetweenTimestamps,
		createSwapRecords,
	};
};
