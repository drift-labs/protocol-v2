import { BaseDynamoRecord, LiquidationRecord, RecordTypes, SecondaryIndex } from '@backend/common';
import {
	BANKRUPTCY_RECORD_ID,
	DynamoDB,
	getBaseRecordFields,
	getPaginatedRecordsWithUniqueIds,
	getRecordKeys,
	LIQUIDATION_RECORD_ID,
	USER_PK,
} from '..';

export const LiquidationRepository = () => {
	const { batchWrite, query } = DynamoDB();

	const createLiquidationRecords = async (liquidationRecords: LiquidationRecord[]) => {
		const records = liquidationRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.LiquidationRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const getLiquidationRecords = async ({
		id,
		page = null,
		maxUniqueRecords = 20,
		bankruptcy = false,
	}: {
		id?: string;
		page?: Record<string, any> | null;
		maxUniqueRecords?: number;
		bankruptcy?: boolean;
	}): Promise<{
		records: (LiquidationRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const queryByUser = id !== undefined && id !== '';

		return getPaginatedRecordsWithUniqueIds<LiquidationRecord & BaseDynamoRecord>({
			queryFn: (lastEvaluatedKey) => {
				const queryParams = queryByUser
					? {
							pk: `${USER_PK}#${id}`,
							sk: LIQUIDATION_RECORD_ID,
							lastEvaluatedKey,
					  }
					: {
							secondaryIndex: SecondaryIndex.GSI1,
							pk: bankruptcy ? BANKRUPTCY_RECORD_ID : LIQUIDATION_RECORD_ID,
							sk: bankruptcy ? BANKRUPTCY_RECORD_ID : LIQUIDATION_RECORD_ID,
							lastEvaluatedKey,
					  };

				return query(queryParams);
			},
			extractUniqueId: (record) => record.liquidationId || null,
			maxUniqueRecords,
			page,
			paginationIndex: queryByUser ? null : SecondaryIndex.GSI1,
		});
	};

	const getLiquidationRecordsBetweenTimestamps = async ({
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
		records: (LiquidationRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${USER_PK}#${id}`,
				':startSk': `${LIQUIDATION_RECORD_ID}#TS#${startTs}`,
				':endSk': `${LIQUIDATION_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (LiquidationRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	return {
		getLiquidationRecords,
		getLiquidationRecordsBetweenTimestamps,
		createLiquidationRecords,
	};
};
