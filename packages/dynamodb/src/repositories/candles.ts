import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
	BaseDynamoRecord,
	CandleRecord,
	CandleResolutions,
	DEFAULT_CANDLE_TABLE,
	RecordTypes,
	TradeRecord,
} from '@backend/common';
import { CANDLE_PK, DynamoDB, getBaseRecordFields, getRecordKeys } from '..';

export const CandleRepository = () => {
	const { batchWrite, query, update, get } = DynamoDB({
		overrideTableName: process.env.CANDLE_TABLE ?? DEFAULT_CANDLE_TABLE,
	});

	const createCandleRecords = async (candleRecords: CandleRecord[]) => {
		const records = candleRecords.map((record) => ({
			...getRecordKeys(record, RecordTypes.CandleRecord),
			...record,
			...getBaseRecordFields(record),
		}));

		return batchWrite({ records });
	};

	const updateCandleRecord = async ({
		trade,
		resolution,
		ts,
		updateOpenOnly = false,
		updateEmptyCandle = false,
	}: {
		trade: TradeRecord & { price: number };
		resolution: CandleResolutions;
		ts: number;
		updateOpenOnly?: boolean;
		updateEmptyCandle?: boolean;
	}) => {
		try {
			const pk = `${CANDLE_PK}#${trade.symbol}#${resolution}`;
			const sk = ts.toString();

			let updateExpression: string;
			const expressionValues: { [key: string]: any } = {
				':price': trade.price,
				':oraclePrice': trade.oraclePrice,
			};

			if (updateOpenOnly) {
				updateExpression = 'SET fillOpen = :price, oracleOpen = :oraclePrice';
			} else if (updateEmptyCandle) {
				updateExpression = `SET fillOpen = :price, fillHigh = :price, fillLow = :price, fillClose = :price, oracleOpen = :oraclePrice, oracleHigh = :oraclePrice, oracleLow = :oraclePrice, oracleClose = :oraclePrice`;
			} else {
				updateExpression =
					'SET fillOpen = if_not_exists(fillOpen, :price), oracleOpen = if_not_exists(oracleOpen, :oraclePrice)';
				expressionValues[':quoteVolume'] = trade.quoteAssetAmountFilled;
				expressionValues[':baseVolume'] = trade.baseAssetAmountFilled;
				updateExpression += ' ADD quoteVolume :quoteVolume, baseVolume :baseVolume';
			}

			const result = await update({
				pk,
				sk,
				updateExpression,
				expressionValues,
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});

			let finalizedCandle = result.Attributes as CandleRecord;

			if (updateOpenOnly || updateEmptyCandle) {
				return finalizedCandle;
			}

			if (
				!finalizedCandle.fillHigh ||
				!finalizedCandle.fillLow ||
				!finalizedCandle.oracleHigh ||
				!finalizedCandle.oracleLow ||
				!finalizedCandle.lastFillRecordId ||
				trade.price > finalizedCandle.fillHigh ||
				trade.price < finalizedCandle.fillLow ||
				trade.oraclePrice > finalizedCandle.oracleHigh ||
				trade.oraclePrice < finalizedCandle.oracleLow ||
				Number(trade.fillRecordId) > Number(finalizedCandle.lastFillRecordId)
			) {
				const updates = [];
				const finalizedValues: { [key: string]: any } = {};

				if (!finalizedCandle.fillHigh || trade.price > finalizedCandle.fillHigh) {
					updates.push('fillHigh = :newFillHigh');
					finalizedValues[':newFillHigh'] = trade.price;
				}

				if (!finalizedCandle.fillLow || trade.price < finalizedCandle.fillLow) {
					updates.push('fillLow = :newFillLow');
					finalizedValues[':newFillLow'] = trade.price;
				}

				if (!finalizedCandle.oracleHigh || trade.oraclePrice > finalizedCandle.oracleHigh) {
					updates.push('oracleHigh = :newOracleHigh');
					finalizedValues[':newOracleHigh'] = trade.oraclePrice;
				}

				if (!finalizedCandle.oracleLow || trade.oraclePrice < finalizedCandle.oracleLow) {
					updates.push('oracleLow = :newOracleLow');
					finalizedValues[':newOracleLow'] = trade.oraclePrice;
				}

				if (
					!finalizedCandle.lastFillRecordId ||
					Number(trade.fillRecordId) > Number(finalizedCandle.lastFillRecordId)
				) {
					updates.push('fillClose = :newFillClose', 'oracleClose = :newOracleClose');
					finalizedValues[':newFillClose'] = trade.price;
					finalizedValues[':newOracleClose'] = trade.oraclePrice;
					updates.push('lastTradeTs = :newLastTradeTs');
					finalizedValues[':newLastTradeTs'] = trade.ts;
					updates.push('lastFillRecordId = :newLastFillRecordId');
					finalizedValues[':newLastFillRecordId'] = trade.fillRecordId;
				}

				if (updates.length > 0) {
					const { Attributes: candleWithHighLow } = await update({
						pk,
						sk,
						updateExpression: `SET ${updates.join(', ')}`,
						expressionValues: finalizedValues,
					});

					finalizedCandle = candleWithHighLow as CandleRecord;
				}
			}

			return finalizedCandle;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				const lastCandle = await getLatestCandle(trade.symbol, resolution);
				const openPrice = lastCandle?.fillClose ?? trade.price;
				const openOraclePrice = lastCandle?.oracleClose ?? trade.oraclePrice;

				const newCandle: CandleRecord = {
					symbol: trade.symbol,
					resolution,
					ts,
					fillOpen: lastCandle?.fillClose ?? trade.price,
					fillHigh: Math.max(openPrice, trade.price),
					fillLow: Math.min(openPrice, trade.price),
					fillClose: trade.price,
					oracleOpen: lastCandle?.oracleClose ?? trade.oraclePrice,
					oracleHigh: Math.max(openOraclePrice, trade.oraclePrice),
					oracleLow: Math.min(openOraclePrice, trade.oraclePrice),
					oracleClose: trade.oraclePrice,
					quoteVolume: trade.quoteAssetAmountFilled,
					baseVolume: trade.baseAssetAmountFilled,
					lastTradeTs: trade.ts,
					lastFillRecordId: trade.fillRecordId,
				};

				await createCandleRecords([newCandle]);
				return newCandle;
			}

			throw error;
		}
	};

	const updateCandleOracle = async ({
		symbol,
		oraclePrice,
		resolution,
		ts,
	}: {
		symbol: string;
		oraclePrice: number;
		resolution: CandleResolutions;
		ts: number;
	}) => {
		try {
			const pk = `${CANDLE_PK}#${symbol}#${resolution}`;
			const sk = ts.toString();

			const result = await update({
				pk,
				sk,
				updateExpression: `SET oracleClose = :oraclePrice`,
				expressionValues: {
					':oraclePrice': oraclePrice,
				},
				conditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
			});

			let finalizedCandle = result.Attributes as CandleRecord;

			if (
				!finalizedCandle.oracleHigh ||
				!finalizedCandle.oracleLow ||
				oraclePrice > finalizedCandle.oracleHigh ||
				oraclePrice < finalizedCandle.oracleLow
			) {
				const updates = [];
				const finalizedValues: { [key: string]: any } = {};

				if (!finalizedCandle.oracleHigh || oraclePrice > finalizedCandle.oracleHigh) {
					updates.push('oracleHigh = :newOracleHigh');
					finalizedValues[':newOracleHigh'] = oraclePrice;
				}

				if (!finalizedCandle.oracleLow || oraclePrice < finalizedCandle.oracleLow) {
					updates.push('oracleLow = :newOracleLow');
					finalizedValues[':newOracleLow'] = oraclePrice;
				}

				if (updates.length > 0) {
					const { Attributes: updatedCandle } = await update({
						pk,
						sk,
						updateExpression: `SET ${updates.join(', ')}`,
						expressionValues: finalizedValues,
					});
					finalizedCandle = updatedCandle as CandleRecord;
				}
			}

			return finalizedCandle;
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				const lastCandle = await getLatestCandle(symbol, resolution);

				// Don't create oracle-only candles if no trades have occurred yet
				if (!lastCandle) {
					return null; // No candles exist yet, don't create oracle-only candle
				}

				const openPrice = lastCandle.fillClose;
				const openOraclePrice = lastCandle.oracleClose;

				const newCandle: CandleRecord = {
					symbol,
					resolution,
					ts,
					fillOpen: openPrice,
					fillHigh: openPrice,
					fillLow: openPrice,
					fillClose: openPrice,
					oracleOpen: openOraclePrice,
					oracleHigh: Math.max(openOraclePrice, oraclePrice),
					oracleLow: Math.min(openOraclePrice, oraclePrice),
					oracleClose: oraclePrice,
					quoteVolume: 0,
					baseVolume: 0,
				};

				await createCandleRecords([newCandle]);
				return newCandle;
			}

			throw error;
		}
	};

	const getLatestCandle = async (symbol: string, resolution: CandleResolutions) => {
		const { Items = [] } = await query({
			pk: `${CANDLE_PK}#${symbol}#${resolution}`,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': `${CANDLE_PK}#${symbol}#${resolution}`,
			},
			limit: 1,
		});

		return Items?.[0] as CandleRecord & BaseDynamoRecord;
	};

	const getCandle = async (symbol: string, resolution: CandleResolutions, ts: number) => {
		const { Item = null } = await get({
			pk: `${CANDLE_PK}#${symbol}#${resolution}`,
			sk: ts.toString(),
		});

		return Item as CandleRecord & BaseDynamoRecord;
	};

	const getCandlesForResolution = async ({
		symbol,
		resolution,
		limit = 100,
	}: {
		symbol: string;
		resolution: CandleResolutions;
		limit?: number;
	}): Promise<(CandleRecord & BaseDynamoRecord)[]> => {
		const { Items = [] } = await query({
			pk: `${CANDLE_PK}#${symbol}#${resolution}`,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': `${CANDLE_PK}#${symbol}#${resolution}`,
			},
			limit,
		});

		const records = Items as (CandleRecord & BaseDynamoRecord)[];

		return records;
	};

	const getCandlesBetweenTimestampsForResolution = async ({
		symbol,
		resolution,
		startTs,
		endTs,
		limit = 20,
	}: {
		symbol: string;
		resolution: CandleResolutions;
		startTs: number;
		endTs: number;
		limit?: number;
	}): Promise<(CandleRecord & BaseDynamoRecord)[]> => {
		const { Items = [] } = await query({
			pk: `${CANDLE_PK}#${symbol}#${resolution}`,
			expression: 'pk = :pk AND sk BETWEEN :endSk AND :startSk',
			limit,
			expressionValues: {
				':pk': `${CANDLE_PK}#${symbol}#${resolution}`,
				':endSk': endTs.toString(),
				':startSk': startTs.toString(),
			},
		});

		const records = Items as (CandleRecord & BaseDynamoRecord)[];

		return records;
	};

	return {
		getLatestCandle,
		getCandle,
		getCandlesForResolution,
		getCandlesBetweenTimestampsForResolution,
		createCandleRecords,
		updateCandleRecord,
		updateCandleOracle,
	};
};
