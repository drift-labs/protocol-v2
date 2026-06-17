import {
	BaseDynamoRecord,
	EntityTypes,
	getTimestamp,
	isFeatureEnabled,
	logger,
	PositionHistoryRecord,
	RecordTypes,
	SecondaryIndex,
	TradeRecord,
} from '@backend/common';
import {
	DynamoDB,
	getBaseRecordFields,
	getPaginatedRecordsWithUniqueIds,
	getRecordKeys,
	getTTLTimestampFromRecord,
	MARKET_PK,
	TRADE_RECORD_ID,
	USER_PK,
} from '..';
import { OrderRepository } from './order';

export const TradeRepository = () => {
	const { batchWrite, query, update } = DynamoDB();
	const { createOrderActionRecords } = OrderRepository();

	const createTradeRecords = async (tradeRecords: TradeRecord[]) => {
		const failedUpdates = await createOrderActionRecords(tradeRecords);

		const records = tradeRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.TradeRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		if (isFeatureEnabled('CUMULATIVE_FEE')) {
			try {
				await updateCumulativeFeeRecords(tradeRecords);
			} catch (error) {
				const { message } = error;
				logger.warn(`Error while updating cumulative fee record: ${message}`);
				logger.info(
					`Keys that failed update: ${JSON.stringify(
						tradeRecords.map((trade) => getRecordKeys(trade, RecordTypes.FeeRecord))
					)}`
				);
			}
		}

		const failedWrites = await batchWrite({ records });
		return [...failedUpdates, ...failedWrites];
	};

	const updateCumulativeFeeRecords = async (tradeRecords: TradeRecord[]) => {
		await Promise.all(
			tradeRecords
				.map((record) => {
					const { user, taker, takerFee, makerFee } = record;
					return {
						...record,
						userFee: user === taker ? takerFee : makerFee,
					};
				})
				.filter(({ user, userFee }) => user && userFee && Math.abs(userFee) > 0)
				.map((record) => {
					return update({
						...getRecordKeys(record, RecordTypes.FeeRecord),
						updateExpression:
							'SET lastUpdatedTs = :timestamp, #ttl = :ttl ADD cumulativeFee :fee, processedFillIds :idSet',
						conditionExpression:
							'attribute_not_exists(processedFillIds) OR NOT contains(processedFillIds, :fillId)',
						expressionNames: {
							'#ttl': 'ttl',
						},
						expressionValues: {
							':fee': record.userFee,
							':timestamp': getTimestamp(),
							':idSet': new Set([record.fillRecordId]),
							':fillId': record.fillRecordId,
							':ttl': getTTLTimestampFromRecord(record.ts),
						},
					});
				})
		);
	};

	const getTradeRecords = async ({
		id,
		entity = EntityTypes.User,
		page = undefined,
		limit = 20,
	}: {
		id: string;
		entity?: EntityTypes;
		page?: Record<string, any> | undefined;
		limit?: number;
	}): Promise<{
		records: (TradeRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			sk: TRADE_RECORD_ID,
			lastEvaluatedKey: page,
			limit,
		});

		const records = Items as (TradeRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getTradeRecordsBySymbol = async ({
		id,
		symbol,
		page = undefined,
	}: {
		id: string;
		symbol: string;
		page?: Record<string, any> | undefined;
	}): Promise<{
		records: (TradeRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${USER_PK}#${id}`,
			sk: `${TRADE_RECORD_ID}#MARKET#${symbol}#`,
			secondaryIndex: SecondaryIndex.GSI1,
			lastEvaluatedKey: page,
		});

		const records = Items as (TradeRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getTradeRecordsBetweenTimestamps = async ({
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
		records: (TradeRecord & BaseDynamoRecord)[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const pk = entity === EntityTypes.User ? USER_PK : MARKET_PK;

		const { Items = [], LastEvaluatedKey = null } = await query({
			pk: `${pk}#${id}`,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			expressionValues: {
				':pk': `${pk}#${id}`,
				':startSk': `${TRADE_RECORD_ID}#TS#${startTs}`,
				':endSk': `${TRADE_RECORD_ID}#TS#${endTs}`,
			},
			lastEvaluatedKey: page,
		});

		const records = Items as (TradeRecord & BaseDynamoRecord)[];

		return { records, meta: { nextPage: LastEvaluatedKey } };
	};

	const getPositionRecords = async ({
		id,
		page = null,
		maxUniqueOrders = 20,
	}: {
		id: string;
		page?: Record<string, any> | null;
		maxUniqueOrders?: number;
	}): Promise<{
		records: PositionHistoryRecord[];
		meta: { nextPage: Record<string, any> | null };
	}> => {
		const expressionValues = {
			':user': id,
			':null': null,
		};
		const filterExpression =
			'(taker = :user AND takerExistingQuoteEntryAmount <> :null) OR (maker = :user AND makerExistingQuoteEntryAmount <> :null)';
		const res = await getPaginatedRecordsWithUniqueIds<
			TradeRecord & BaseDynamoRecord,
			PositionHistoryRecord
		>({
			queryFn: (lastEvaluatedKey) =>
				query({
					pk: `${USER_PK}#${id}`,
					sk: TRADE_RECORD_ID,
					filterExpression,
					expressionValues,
					lastEvaluatedKey,
					limit: 300,
				}),
			extractUniqueId: (record) => record.userOrderId || null,
			maxUniqueRecords: maxUniqueOrders,
			page,
			combineRecordsFn: (records) => {
				const initialRecord: PositionHistoryRecord = {
					...records[0],
					baseClosedForPnl:
						(records[0].userExistingBaseAssetAmount ?? 0) > 0
							? records[0].userExistingBaseAssetAmount ?? 0
							: records[0].baseAssetAmountFilled ?? 0,
					userFee: records[0].taker === id ? records[0].takerFee : records[0].makerFee,
				};

				return records.reduce<PositionHistoryRecord>((acc, record, index) => {
					if (index === 0) {
						// we already added the initial record to the accumulator
						return acc;
					}
					const baseClosedForPnl =
						(record.userExistingBaseAssetAmount ?? 0) > 0
							? record.userExistingBaseAssetAmount
							: record.baseAssetAmountFilled;
					const quoteEntryAmount = record.userExistingQuoteEntryAmount ?? 0;
					const quoteFilled = record.quoteAssetAmountFilled ?? 0;
					const baseFilled = record.baseAssetAmountFilled;
					const fee = record.taker === id ? record.takerFee : record.makerFee;
					return {
						...acc,
						baseClosedForPnl: acc.baseClosedForPnl + (baseClosedForPnl ?? 0),
						userExistingQuoteEntryAmount:
							(acc.userExistingQuoteEntryAmount ?? 0) + quoteEntryAmount,
						takerExistingQuoteEntryAmount:
							(acc.takerExistingQuoteEntryAmount ?? 0) +
							(record.takerExistingQuoteEntryAmount ?? 0),
						makerExistingQuoteEntryAmount:
							(acc.makerExistingQuoteEntryAmount ?? 0) +
							(record.makerExistingQuoteEntryAmount ?? 0),
						userExistingBaseAssetAmount:
							(acc.userExistingBaseAssetAmount ?? 0) +
							(record.userExistingBaseAssetAmount ?? 0),
						takerExistingBaseAssetAmount:
							(acc.takerExistingBaseAssetAmount ?? 0) +
							(record.takerExistingBaseAssetAmount ?? 0),
						makerExistingBaseAssetAmount:
							(acc.makerExistingBaseAssetAmount ?? 0) +
							(record.makerExistingBaseAssetAmount ?? 0),
						quoteAssetAmountFilled: acc.quoteAssetAmountFilled + quoteFilled,
						baseAssetAmountFilled: acc.baseAssetAmountFilled + baseFilled,
						userFee: acc.userFee + fee,
					};
				}, initialRecord);
			},
		});
		return res;
	};

	return {
		getTradeRecords,
		getTradeRecordsBySymbol,
		getTradeRecordsBetweenTimestamps,
		getPositionRecords,
		createTradeRecords,
	};
};
