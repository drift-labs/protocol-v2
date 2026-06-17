import { BaseDynamoRecord, EntityTypes, RecordTypes, RewardRecord } from '@backend/common';
import {
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	MARKET_PK,
	REWARD_RECORD_ID,
	USER_PK,
} from '..';

export const RewardRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createRewardRecords = async (rewardRecords: RewardRecord[]) => {
		const records = rewardRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.RewardRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getRewardRecords = async ({
		id,
		entity = EntityTypes.User,
		page = undefined,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (RewardRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: REWARD_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (RewardRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getRewardRecordsBetweenTimestamps = async ({
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
		records: (RewardRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${REWARD_RECORD_ID}#TS#${startTs}`,
				':endSk': `${REWARD_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (RewardRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getRewardRecords,
		getRewardRecordsBetweenTimestamps,
		createRewardRecords,
	};
};
