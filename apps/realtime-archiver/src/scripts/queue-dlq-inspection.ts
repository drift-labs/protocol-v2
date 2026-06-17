import { DynamoDBStreams } from '@aws-sdk/client-dynamodb-streams';
import { Lambda } from '@aws-sdk/client-lambda';
import { logger } from '@backend/common';
import { SQS } from '@backend/sqs';

interface DDBStreamBatchInfo {
	shardId: string;
	startSequenceNumber: string;
	endSequenceNumber: string;
	approximateArrivalOfFirstRecord: string;
	approximateArrivalOfLastRecord: string;
	batchSize: number;
	streamArn: string;
}

interface DLQMessage {
	requestContext: {
		requestId: string;
		functionArn: string;
		condition: string;
		approximateInvokeCount: number;
	};
	responseContext: {
		statusCode: number;
		executedVersion: string;
		functionError: string;
	};
	version: string;
	timestamp: string;
	DDBStreamBatchInfo: DDBStreamBatchInfo;
}

const dynamoStreams = new DynamoDBStreams({});
const lambda = new Lambda({});
const { getMessages, deleteMessages } = SQS();

async function processStreamMessage(dlqMessage: DLQMessage): Promise<void> {
	const { DDBStreamBatchInfo: streamInfo, requestContext } = dlqMessage;

	try {
		logger.info('Getting shard iterator...');
		const shardIteratorResponse = await dynamoStreams.getShardIterator({
			StreamArn: streamInfo.streamArn,
			ShardId: streamInfo.shardId,
			ShardIteratorType: 'AT_SEQUENCE_NUMBER',
			SequenceNumber: streamInfo.startSequenceNumber,
		});

		if (!shardIteratorResponse.ShardIterator) {
			throw new Error('Failed to get shard iterator');
		}

		logger.info('Getting records from stream...');
		const records = await dynamoStreams.getRecords({
			ShardIterator: shardIteratorResponse.ShardIterator,
			Limit: streamInfo.batchSize,
		});

		if (!records.Records || records.Records.length === 0) {
			throw new Error('No records found for the given sequence numbers');
		}

		const streamEvent = {
			Records: records.Records,
		};

		logger.info('Invoking target Lambda...');

		await lambda.invoke({
			FunctionName: requestContext.functionArn,
			InvocationType: 'Event',
			Payload: new TextEncoder().encode(JSON.stringify(streamEvent)),
		});

		logger.info(
			`Successfully processed message: ${JSON.stringify({
				requestId: requestContext.requestId,
				recordCount: records.Records.length,
			})}`
		);
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Error processing stream message: ${message}`);
		throw error;
	}
}

async function processDLQMessages(): Promise<void> {
	let totalProcessed = 0;
	let totalFailed = 0;
	let continuationCount = 0;

	logger.info('Starting to process DLQ messages...');

	const loop = true;
	while (loop) {
		try {
			const messages = await getMessages({
				maxMessages: 10,
				visibilityTimeout: 300,
				waitTimeSeconds: 0,
			});

			if (messages.length === 0) {
				if (continuationCount === 0) {
					logger.info(
						`No more messages to process. Total processed: ${totalProcessed}, Total failed: ${totalFailed}`
					);
					break;
				}
				continuationCount = 0;
				continue;
			}

			continuationCount++;

			logger.info(
				`Processing batch of ${messages.length} messages (Total processed so far: ${totalProcessed})`
			);

			const deleteEntries = messages.map((message) => ({
				Id: message.MessageId!,
				ReceiptHandle: message.ReceiptHandle!,
			}));

			const successfulDeletes: string[] = [];

			const processResults = await Promise.all(
				messages.map(async (message) => {
					try {
						const dlqMessage: DLQMessage = JSON.parse(message.Body!);
						await processStreamMessage(dlqMessage);
						return {
							success: true,
							messageId: message.MessageId!,
						};
					} catch (error) {
						logger.error(
							`Failed to process message ${message.MessageId}: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
						return {
							success: false,
							messageId: message.MessageId!,
						};
					}
				})
			);

			processResults.forEach((result) => {
				if (result.success) {
					successfulDeletes.push(result.messageId);
					totalProcessed++;
				} else {
					totalFailed++;
				}
			});

			if (successfulDeletes.length > 0) {
				const entriesToDelete = deleteEntries.filter((entry) =>
					successfulDeletes.includes(entry.Id)
				);

				const failedDeletes = await deleteMessages(entriesToDelete);

				if (failedDeletes.length > 0) {
					logger.error(`Failed to delete ${failedDeletes.length} messages from queue`);
				}
			}

			logger.info(
				`Batch complete. Current batch: ${successfulDeletes.length} processed, ${
					messages.length - successfulDeletes.length
				} failed`
			);
		} catch (error) {
			logger.error(
				`Error processing DLQ batch: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			throw error;
		}
	}
}

async function main() {
	try {
		logger.info('Starting DLQ processing script...');
		await processDLQMessages();
		logger.info('Finished processing DLQ messages');
	} catch (error) {
		const { message } = error as Error;
		logger.error(`Script failed: ${message}`);
		process.exit(1);
	}
}

main();
