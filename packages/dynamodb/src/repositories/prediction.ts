import {
	BaseDynamoRecord,
	EntityTypes,
	PredictionRecord,
	RecordTypes,
	SecondaryIndex,
} from '@backend/common';
import {
	DynamoDB,
	getBaseRecordFields,
	getRecordKeys,
	MARKET_PK,
	PREDICTION_RECORD_ID,
	USER_PK,
} from '..';
import { OrderRepository } from './order';

export const PredictionRepository = () => {
	const { batchWrite, query } = DynamoDB();
	const { createOrderActionRecords } = OrderRepository();

	const createPredictionRecords = async (predictionRecords: PredictionRecord[]) => {
		const failedUpdates = await createOrderActionRecords(predictionRecords);

		const records = predictionRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.PredictionRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		const failedWrites = await batchWrite({ records });

		return [...failedUpdates, ...failedWrites];
	};

	const getPredictionRecords = async ({
		id,
		entity = EntityTypes.User,
		page = undefined,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (PredictionRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: PREDICTION_RECORD_ID,
			lastEvaluatedKey: page,
		});

		const records = Items as (PredictionRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getPredictionRecordsBySymbol = async ({
		id,
		symbol,
		page = undefined,
	}: {
		id: string;
		symbol: string;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (PredictionRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			sk: `${PREDICTION_RECORD_ID}#MARKET#${symbol}#`,
			secondaryIndex: SecondaryIndex.GSI1,
			lastEvaluatedKey: page,
		});

		const records = Items as (PredictionRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getPredictionRecordsBetweenTimestamps = async ({
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
		records: (PredictionRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${pk}#${id}`,
				':startSk': `${PREDICTION_RECORD_ID}#TS#${startTs}`,
				':endSk': `${PREDICTION_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (PredictionRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getPredictionRecords,
		getPredictionRecordsBySymbol,
		getPredictionRecordsBetweenTimestamps,
		createPredictionRecords,
	};
};
