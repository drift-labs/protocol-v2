import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	BatchGetCommand,
	BatchGetCommandInput,
	BatchWriteCommand,
	BatchWriteCommandInput,
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	NativeAttributeValue,
	PutCommand,
	PutCommandInput,
	QueryCommand,
	QueryCommandInput,
	QueryCommandOutput,
	TransactWriteCommand,
	TransactWriteCommandInput,
	UpdateCommand,
	UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import {
	batchArray,
	DEFAULT_DYNAMO_TABLE,
	ExpressionValues,
	logger,
	SecondaryIndex,
	TransactWriteItem,
} from '@backend/common';

import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
	maxConcurrent: 10,
	minTime: 10,
});

const dynamoEndpoint = process.env.DYNAMO_ENDPOINT_URL ?? process.env.AWS_ENDPOINT_URL;
const dynamodb = new DynamoDBClient({
	...(dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}),
	retryStrategy: new ConfiguredRetryStrategy(5, (attempt: number) => 100 + attempt * 500),
});
const ddb = DynamoDBDocumentClient.from(dynamodb);

export const DynamoDB = ({ overrideTableName }: { overrideTableName?: string } = {}) => {
	const table = overrideTableName ?? process.env.DYNAMO_TABLE ?? DEFAULT_DYNAMO_TABLE;

	const get = async ({ pk, sk }: { pk: string; sk: string }) => {
		return ddb.send(
			new GetCommand({
				TableName: table,
				Key: {
					pk,
					sk,
				},
			})
		);
	};

	const query = async ({
		pk,
		sk,
		secondaryIndex,
		expression,
		expressionValues,
		filterExpression,
		lastEvaluatedKey,
		limit,
		orderAsc = false,
	}: {
		pk: string;
		sk?: string;
		secondaryIndex?: SecondaryIndex;
		expression?: string;
		expressionValues?: ExpressionValues;
		filterExpression?: string;
		lastEvaluatedKey?: any;
		limit?: number;
		orderAsc?: boolean;
	}) => {
		const primaryKey = secondaryIndex ? `${secondaryIndex}PK` : 'pk';
		const secondaryKey = secondaryIndex ? `${secondaryIndex}SK` : 'sk';

		const expressionString =
			expression ??
			(sk
				? `${primaryKey} = :pk and begins_with(${secondaryKey}, :sk)`
				: `${primaryKey} = :pk`);

		let defaultValues: { ':pk': string; ':sk'?: string } = { ':pk': pk };

		if (sk) {
			defaultValues = { ':pk': pk, ':sk': sk };
		}

		const params: QueryCommandInput = {
			TableName: table,
			KeyConditionExpression: expressionString,
			Limit: limit ?? 20,
			ExpressionAttributeValues: expressionValues
				? { ...defaultValues, ...expressionValues }
				: defaultValues,
			ScanIndexForward: orderAsc,
		};

		if (filterExpression) {
			params.FilterExpression = filterExpression;
		}

		if (secondaryIndex) {
			params.IndexName = secondaryIndex;
		}

		if (lastEvaluatedKey) {
			params.ExclusiveStartKey = lastEvaluatedKey;
		}

		return ddb.send(new QueryCommand(params));
	};

	const queryAll = async ({
		pk,
		sk,
		secondaryIndex,
		expression,
		expressionValues,
		filterExpression,
		orderAsc = false,
	}: {
		pk: string;
		sk?: string;
		secondaryIndex?: SecondaryIndex;
		expression?: string;
		expressionValues?: ExpressionValues;
		filterExpression?: string;
		orderAsc?: boolean;
	}) => {
		let lastEvaluatedKey: Record<string, any> | undefined = undefined;
		const allItems: Record<string, any>[] = [];

		do {
			const { Items, LastEvaluatedKey }: QueryCommandOutput = await query({
				pk,
				sk,
				secondaryIndex,
				expression,
				expressionValues,
				filterExpression,
				lastEvaluatedKey,
				orderAsc,
				limit: 1000,
			});

			if (Items) {
				allItems.push(...Items);
			}

			lastEvaluatedKey = LastEvaluatedKey;

			if (lastEvaluatedKey) {
				logger.info(
					`Fetched batch of ${Items?.length} items, continuing from: ${JSON.stringify(
						lastEvaluatedKey
					)}`
				);
			}
		} while (lastEvaluatedKey);

		logger.info(`Total items fetched: ${allItems.length}`);
		return allItems;
	};

	const put = async ({
		record,
		conditionExpression,
	}: {
		record: Record<string, any> | undefined;
		conditionExpression?: string;
	}) => {
		const params: PutCommandInput = {
			TableName: table,
			Item: {
				...record,
			},
		};

		if (conditionExpression) {
			params.ConditionExpression = conditionExpression;
		}

		return ddb.send(new PutCommand(params));
	};

	const remove = async ({ pk, sk }: { pk: string; sk: string }) => {
		return ddb.send(
			new DeleteCommand({
				TableName: table,
				Key: {
					pk,
					sk,
				},
			})
		);
	};

	const update = async ({
		pk,
		sk,
		updateExpression,
		conditionExpression,
		expressionValues,
		expressionNames,
	}: {
		pk: string;
		sk: string;
		updateExpression: string;
		conditionExpression?: string;
		expressionValues: ExpressionValues;
		expressionNames?: Record<string, string>;
	}) => {
		const params: UpdateCommandInput = {
			TableName: table,
			Key: {
				pk,
				sk,
			},
			UpdateExpression: updateExpression,
			ExpressionAttributeValues: expressionValues,
			ReturnValues: 'ALL_NEW',
		};

		if (conditionExpression) {
			params.ConditionExpression = conditionExpression;
		}

		if (expressionNames) {
			params.ExpressionAttributeNames = expressionNames;
		}

		return ddb.send(new UpdateCommand(params));
	};

	const batchWrite = async ({ records }: { records: Record<string, any>[] }) => {
		const batchSize = 25; // BatchWrite API limit
		const batches = batchArray(records, batchSize);
		const failedItems: Record<string, NativeAttributeValue>[] = [];

		logger.info(`Number of batches: ${batches.length}, Number of records: ${records.length}`);

		const processBatch = async (batch: Record<string, any>[], index: number) => {
			logger.info(`Processing batch ${index}: ${batch.length} records`);
			const params: BatchWriteCommandInput = {
				RequestItems: {
					[table]: batch.map((item) => ({
						PutRequest: { Item: item },
					})),
				},
			};

			try {
				const result = await ddb.send(new BatchWriteCommand(params));
				if (result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0) {
					await logger.warn(
						`Some items were not processed: ${JSON.stringify(result.UnprocessedItems)}`
					);
				}
				const unprocessedItems = result.UnprocessedItems?.[table];

				return unprocessedItems?.forEach((request) => {
					if (request && request['PutRequest'] && request['PutRequest'].Item)
						failedItems.push(request['PutRequest'].Item);
				});
			} catch (error) {
				await logger.error(`Error in Dynamo BatchWrite: ${error}`);
				throw error;
			}
		};

		await Promise.all(
			batches.map((batch, index) => limiter.schedule(() => processBatch(batch, index)))
		);

		return failedItems;
	};

	const batchRemove = async ({ records }: { records: { pk: string; sk: string }[] }) => {
		const batchSize = 25; // BatchWrite API limit
		const batches = batchArray(records, batchSize);
		const failedItems: Record<string, NativeAttributeValue>[] = [];

		logger.info(`Number of batches: ${batches.length}, Number of records: ${records.length}`);

		const processBatch = async (batch: { pk: string; sk: string }[], index: number) => {
			logger.info(`Processing delete batch ${index}: ${batch.length} records`);
			const params: BatchWriteCommandInput = {
				RequestItems: {
					[table]: batch.map((item) => ({
						DeleteRequest: {
							Key: {
								pk: item.pk,
								sk: item.sk,
							},
						},
					})),
				},
			};

			try {
				const result = await ddb.send(new BatchWriteCommand(params));
				if (result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0) {
					await logger.warn(
						`Some items were not deleted: ${JSON.stringify(result.UnprocessedItems)}`
					);
				}
				const unprocessedItems = result.UnprocessedItems?.[table];

				return unprocessedItems?.forEach((request) => {
					if (request && request.DeleteRequest && request.DeleteRequest.Key)
						failedItems.push(request.DeleteRequest.Key);
				});
			} catch (error) {
				await logger.error(`Error in Dynamo BatchDelete: ${error}`);
				throw error;
			}
		};

		await Promise.all(
			batches.map((batch, index) => limiter.schedule(() => processBatch(batch, index)))
		);

		return failedItems;
	};

	const batchGet = async ({ keys }: { keys: { pk: string; sk: string }[] }) => {
		const batchSize = 100;
		const batches = batchArray(keys, batchSize);
		const allItems: Record<string, any>[] = [];

		const processBatch = async (batch: { pk: string; sk: string }[]) => {
			const params: BatchGetCommandInput = {
				RequestItems: {
					[table]: {
						Keys: batch,
					},
				},
			};

			try {
				const result = await ddb.send(new BatchGetCommand(params));

				if (result.Responses && result.Responses[table]) {
					allItems.push(...result.Responses[table]);
				}

				if (result.UnprocessedKeys && Object.keys(result.UnprocessedKeys).length > 0) {
					await logger.warn(
						`Some keys were not processed: ${JSON.stringify(result.UnprocessedKeys)}`
					);
				}

				return result;
			} catch (error) {
				await logger.error(`Error in Dynamo BatchGet: ${error}`);
				throw error;
			}
		};

		await Promise.all(batches.map((batch) => limiter.schedule(() => processBatch(batch))));

		return allItems;
	};

	const transact = async ({ items }: { items: TransactWriteItem[] }) => {
		const transactItems = items.map((item) => {
			if (item.Put) {
				return {
					Put: {
						TableName: table,
						Item: item.Put.Item,
						ConditionExpression: item.Put.ConditionExpression,
						ExpressionAttributeNames: item.Put.ExpressionAttributeNames,
						ExpressionAttributeValues: item.Put.ExpressionAttributeValues,
					},
				};
			}
			if (item.Delete) {
				return {
					Delete: {
						TableName: table,
						Key: item.Delete.Key,
						ConditionExpression: item.Delete.ConditionExpression,
						ExpressionAttributeNames: item.Delete.ExpressionAttributeNames,
						ExpressionAttributeValues: item.Delete.ExpressionAttributeValues,
					},
				};
			}
			if (item.Update) {
				return {
					Update: {
						TableName: table,
						Key: item.Update.Key,
						UpdateExpression: item.Update.UpdateExpression,
						ConditionExpression: item.Update.ConditionExpression,
						ExpressionAttributeNames: item.Update.ExpressionAttributeNames,
						ExpressionAttributeValues: item.Update.ExpressionAttributeValues,
					},
				};
			}
			throw new Error('Invalid transaction item');
		});

		const params: TransactWriteCommandInput = {
			TransactItems: transactItems,
		};

		try {
			return await ddb.send(new TransactWriteCommand(params));
		} catch (error) {
			logger.error(`Error in Dynamo TransactWrite: ${error}`);
			throw error;
		}
	};

	return {
		get,
		query,
		queryAll,
		put,
		batchWrite,
		batchRemove,
		batchGet,
		remove,
		update,
		transact,
	};
};
