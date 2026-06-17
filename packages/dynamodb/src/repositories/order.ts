import {
	BaseDynamoRecord,
	compareActions,
	EntityTypes,
	getOrderStatus,
	getTimestamp,
	isFeatureEnabled,
	logger,
	OrderAction,
	OrderActionRecord,
	OrderFillStatusRecord,
	OrderRecord,
	RecordTypes,
	SecondaryIndex,
	SerializedMarketFilter,
} from '@backend/common';
import Bottleneck from 'bottleneck';
import {
	DynamoDB,
	FEE_RECORD_ID,
	getBaseRecordFields,
	getOrderRecordPrimaryKeysV2,
	getRecordKeys,
	getTTLTimestampFromRecord,
	ORDER_ACTION_RECORD_ID,
	ORDER_FILL_STATUS_RECORD_ID,
	ORDER_RECORD_ID,
	USER_PK,
} from '..';

const limiter = new Bottleneck({
	maxConcurrent: 20,
});

export const OrderRepository = () => {
	const { batchWrite, query, get, put } = DynamoDB();

	const createOrderRecords = async (orderRecords: OrderRecord[]) => {
		const records = orderRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.OrderRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const createOrderActionRecords = async (orderActionRecords: OrderActionRecord[]) => {
		const userActionRecords = orderActionRecords.filter((record) => {
			return record.entity === EntityTypes.User;
		});

		const records = userActionRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.OrderActionRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		// Write actions first - these are the source of truth
		const failedWrites = await batchWrite({ records });

		// Create a Set of failed write identifiers for quick lookup
		const failedWriteKeys = new Set(
			failedWrites.map((failed) => `${failed.user}#${failed.userOrderId}`)
		);

		// Only update latest for records that successfully wrote
		const successfulRecords = userActionRecords.filter(
			(record) => !failedWriteKeys.has(`${record.user}#${record.userOrderId}`)
		);

		if (!isFeatureEnabled('ORDER_FILL_STATUS', true)) {
			return failedWrites;
		}

		const failedUpdateRecords = await updateOrderFillStatusRecords(successfulRecords);

		// Map failed updates back to the same format as batchWrite returns
		const failedUpdates = failedUpdateRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.OrderActionRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		// Combine both types of failures - all in the same format
		return [...failedWrites, ...failedUpdates];
	};

	const updateOrderFillStatusRecords = async (records: OrderActionRecord[]) => {
		const fillRecords = records.filter((record) => record.action === OrderAction.FILL);

		const results = await Promise.all(
			fillRecords.map((record) =>
				limiter.schedule(async () => {
					try {
						const marketFilter =
							record.marketFilter ?? (record.marketType as SerializedMarketFilter);

						const fillStatusRecord: OrderFillStatusRecord = {
							user: record.user!,
							orderId: record.userOrderId!,
							ts: record.ts,
							marketFilter,
							symbol: record.symbol!,
						};

						await put({
							record: {
								...getRecordKeys(
									fillStatusRecord,
									RecordTypes.OrderFillStatusRecord
								),
								...fillStatusRecord,
								ttl: getTTLTimestampFromRecord(record.ts),
							},
						});

						return null;
					} catch (error) {
						logger.warn(
							`Failed to update order fill status for user:${record.user}, orderId:${record.userOrderId}`
						);
						return record;
					}
				})
			)
		);

		return results.filter((result): result is OrderActionRecord => result !== null);
	};

	const getOrderRecords = async ({
		id,
		marketFilter,
		symbol,
		startTs,
		endTs,
		hasFill,
		limit = 20,
		page = undefined,
	}: {
		id: string;
		marketFilter: SerializedMarketFilter;
		symbol?: string;
		startTs?: number;
		endTs?: number;
		hasFill?: boolean;
		limit?: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (OrderRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const resolvedStartTs = startTs ?? 0;
		const resolvedEndTs = endTs ?? getTimestamp();

		if (hasFill === true) {
			return getOrderRecordsByFillStatusIndex({
				id,
				symbol,
				marketFilter,
				startTs: resolvedStartTs,
				endTs: resolvedEndTs,
				limit,
				page,
			});
		}

		if (symbol !== undefined) {
			return getOrderRecordsBySymbolIndex({
				id,
				symbol,
				startTs: resolvedStartTs,
				endTs: resolvedEndTs,
				limit,
				page,
			});
		}

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':startSk': `${ORDER_RECORD_ID}#TYPE#${marketFilter.toUpperCase()}#TS#${resolvedStartTs}`,
				':endSk': `${ORDER_RECORD_ID}#TYPE#${marketFilter.toUpperCase()}#TS#${resolvedEndTs}`,
			},
			lastEvaluatedKey: page,
			limit,
		});

		const orderRecords = Items as OrderRecord[];

		const records = (await Promise.all(
			orderRecords.map((record) => limiter.schedule(() => mergeOrderWithLatestAction(record)))
		)) as (OrderRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getOrderRecordsByFillStatusIndex = async ({
		id,
		symbol,
		marketFilter,
		startTs,
		endTs,
		limit = 20,
		page = undefined,
	}: {
		id: string;
		symbol?: string;
		marketFilter: SerializedMarketFilter;
		startTs: number;
		endTs: number;
		limit?: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (OrderRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const typePrefix = `${ORDER_FILL_STATUS_RECORD_ID}#TYPE#${marketFilter.toUpperCase()}#TS#`;
		const marketPrefix = `${ORDER_FILL_STATUS_RECORD_ID}#MARKET#${symbol?.toUpperCase()}#TS#`;
		const pk = `${USER_PK}#${id}`;

		const queryParams = symbol
			? {
					pk,
					secondaryIndex: SecondaryIndex.GSI1,
					expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
					expressionValues: {
						':startSk': `${marketPrefix}${startTs}`,
						':endSk': `${marketPrefix}${endTs}`,
					},
			  }
			: {
					pk,
					secondaryIndex: SecondaryIndex.GSI2,
					expression: 'GSI2PK = :pk AND GSI2SK BETWEEN :startSk AND :endSk',
					expressionValues: {
						':startSk': `${typePrefix}${startTs}`,
						':endSk': `${typePrefix}${endTs}`,
					},
			  };

		const { Items = [], LastEvaluatedKey = null } = await query({
			...queryParams,
			lastEvaluatedKey: page,
			limit,
		});

		const statusRecords = Items as (OrderFillStatusRecord & BaseDynamoRecord)[];
		const orderIds = Array.from(new Set(statusRecords.map((record) => record.orderId)));

		const { records } = await getOrderRecordsByIds({
			user: id,
			orderIds,
			includeLatest: true,
		});

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getOrderRecordsBySymbolIndex = async ({
		id,
		symbol,
		startTs,
		endTs,
		limit = 20,
		page = undefined,
	}: {
		id: string;
		symbol: string;
		startTs: number;
		endTs: number;
		limit?: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (OrderRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			expression: 'GSI1PK = :pk AND GSI1SK BETWEEN :startSk AND :endSk',
			expressionValues: {
				':startSk': `${ORDER_RECORD_ID}#MARKET#${symbol}#TS#${startTs}`,
				':endSk': `${ORDER_RECORD_ID}#MARKET#${symbol}#TS#${endTs}`,
			},
			secondaryIndex: SecondaryIndex.GSI1,
			lastEvaluatedKey: page,
			limit,
		});

		const orderRecords = Items as OrderRecord[];

		const records = (await Promise.all(
			orderRecords.map((record) => limiter.schedule(() => mergeOrderWithLatestAction(record)))
		)) as (OrderRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const mergeOrderWithLatestAction = async (record: OrderRecord) => {
		// TODO: Move this to latest action record once ingestion has been running long
		// enough
		const [{ Items = [] }, fee] = await Promise.all([
			query({
				pk: `${USER_PK}#${record.user}#${ORDER_RECORD_ID}#${record.orderId}`,
				sk: `${ORDER_ACTION_RECORD_ID}`,
				limit: 2,
			}),
			get({
				pk: `${USER_PK}#${record.user}#${ORDER_RECORD_ID}#${record.orderId}`,
				sk: `${FEE_RECORD_ID}`,
			}),
		]);

		if (Items.length === 0) {
			logger.warn(
				`Could not find order action for user:${record.user}, orderId:${record.orderId}`
			);
			return record;
		}

		let latestAction;

		const firstAction = Items[0];
		const secondAction = Items[1];

		// Actions can come out of order as they can be sent in different tx's within the same ts and slot
		if (
			Items.length > 1 &&
			firstAction.ts === secondAction.ts &&
			firstAction.slot === secondAction.slot
		) {
			const { Items: sameTimestampItems = [] } = await query({
				pk: `${USER_PK}#${record.user}#${ORDER_RECORD_ID}#${record.orderId}`,
				sk: `${ORDER_ACTION_RECORD_ID}#TS#${firstAction.ts}#SLOT#${firstAction.slot}`,
			});

			const sortedRecords = (sameTimestampItems as OrderActionRecord[]).sort(compareActions);
			latestAction = sortedRecords[0];
		} else {
			latestAction = Items[0] as OrderActionRecord;
		}

		if (!latestAction) {
			logger.warn(
				`Could not find order action for user:${record.user}, orderId:${record.orderId}`
			);
			return record;
		}

		const key = latestAction.taker === latestAction.user ? 'taker' : 'maker';

		const newBaseAssetFilled = latestAction[`${key}OrderCumulativeBaseAssetAmountFilled`];
		const newQuoteAssetFilled = latestAction[`${key}OrderCumulativeQuoteAssetAmountFilled`];

		const status = getOrderStatus(
			latestAction.action,
			newBaseAssetFilled,
			latestAction[`${key}OrderBaseAssetAmount`]
		);

		return {
			...record,
			lastUpdatedTs: latestAction.ts,
			lastActionStatus: status,
			lastActionExplanation: latestAction.actionExplanation,
			cumulativeFee: fee.Item?.cumulativeFee ?? null,
			baseAssetAmountFilled: newBaseAssetFilled,
			quoteAssetAmountFilled: newQuoteAssetFilled,
		};
	};

	const getOrderActionRecords = async ({
		accountId,
		orderId,
		page = undefined,
	}: {
		accountId: string;
		orderId: number;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (OrderActionRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${accountId}#${ORDER_RECORD_ID}#${orderId}`,
			sk: `${ORDER_ACTION_RECORD_ID}`,
			lastEvaluatedKey: page,
		});
		const sortedRecords = (Items as OrderActionRecord[]).sort(compareActions);
		return {
			records: sortedRecords as (OrderActionRecord & BaseDynamoRecord)[],
			meta: { nextPage: LastEvaluatedKey },
		};
	};

	const getOrderRecordById = async ({
		user,
		orderId,
		includeLatest = false,
	}: {
		user: string;
		orderId: number;
		includeLatest?: boolean;
	}): Promise<(OrderRecord & BaseDynamoRecord) | null> => {
		const { Items = [] } = await query({
			pk: `${USER_PK}#${user}#${ORDER_RECORD_ID}#${orderId}`,
			secondaryIndex: SecondaryIndex.GSI2,
			expression: 'GSI2PK = :pk',
			limit: 1,
		});

		const orderRecord = Items[0] as (OrderRecord & BaseDynamoRecord) | undefined;

		if (!orderRecord) {
			return null;
		}

		if (!includeLatest) {
			return orderRecord;
		}

		return (await mergeOrderWithLatestAction(
			orderRecord as OrderRecord & BaseDynamoRecord
		)) as OrderRecord & BaseDynamoRecord;
	};

	const getOrderRecordsByIds = async ({
		user,
		orderIds,
		includeLatest = false,
	}: {
		user: string;
		orderIds: number[];
		includeLatest?: boolean;
	}): Promise<{
		records: (OrderRecord & BaseDynamoRecord)[];
		missingOrderIds: number[];
	}> => {
		if (orderIds.length === 0) {
			return { records: [], missingOrderIds: [] };
		}

		const results = await Promise.all(
			orderIds.map((orderId) =>
				limiter.schedule(() => getOrderRecordById({ user, orderId, includeLatest }))
			)
		);

		const records: (OrderRecord & BaseDynamoRecord)[] = [];
		const missingOrderIds: number[] = [];

		results.forEach((record, index) => {
			if (record) {
				records.push(record);
			} else {
				missingOrderIds.push(orderIds[index]);
			}
		});

		return { records, missingOrderIds };
	};

	const getOrderRecordFromAction = async ({
		user,
		orderId,
		includeLatest = false,
	}: {
		user: string;
		orderId: number;
		includeLatest?: boolean;
		page?: Record<string, any> | undefined;
	}): Promise<(OrderRecord & BaseDynamoRecord) | null> => {
		const orderRecord = await getOrderRecordById({ user, orderId, includeLatest });

		if (orderRecord) {
			return orderRecord;
		}

		const { Items: actionItems = [] } = await query({
			pk: `${USER_PK}#${user}#${ORDER_RECORD_ID}#${orderId}`,
			sk: `${ORDER_ACTION_RECORD_ID}`,
			orderAsc: true,
			limit: 1,
		});

		const firstAction = actionItems[0];

		if (!firstAction) {
			return null;
		}

		const { Item } = await get(
			getOrderRecordPrimaryKeysV2({
				user,
				orderId,
				marketFilter: firstAction.marketFilter,
				ts: firstAction.ts,
			})
		);

		if (!Item) {
			return null;
		}

		const record = Item as OrderRecord & BaseDynamoRecord;

		if (!includeLatest) {
			return record;
		}

		return (await mergeOrderWithLatestAction(record)) as OrderRecord & BaseDynamoRecord;
	};

	return {
		getOrderRecords,
		getOrderActionRecords,
		getOrderRecordById,
		getOrderRecordsByIds,
		getOrderRecordFromAction,
		createOrderRecords,
		createOrderActionRecords,
	};
};
