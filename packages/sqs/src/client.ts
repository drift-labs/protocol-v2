import {
	DeleteMessageBatchCommand,
	DeleteMessageBatchRequestEntry,
	ReceiveMessageCommand,
	SQSClient,
	SendMessageBatchCommand,
	SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';

import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import { DEFAULT_SQS_QUEUE, batchArray, logger } from '@backend/common';
import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
	maxConcurrent: 5,
});

const sqsEndpoint = process.env.SQS_ENDPOINT_URL ?? process.env.AWS_ENDPOINT_URL;
const sqs = new SQSClient({
	...(sqsEndpoint ? { endpoint: sqsEndpoint } : {}),
	retryStrategy: new ConfiguredRetryStrategy(5, (attempt: number) => 100 + attempt * 500),
});

export const SQS = ({ overrideQueueUrl }: { overrideQueueUrl?: string } = {}) => {
	const queueUrl = overrideQueueUrl ?? process.env.SQS_QUEUE_URL ?? DEFAULT_SQS_QUEUE;

	const putMessages = async ({
		records,
		overrideQueue = undefined,
	}: {
		records: SendMessageBatchRequestEntry[];
		overrideQueue?: string;
	}) => {
		const batchSize = 10;
		const batches = batchArray(records, batchSize);

		logger.info(`Number of batches: ${batches.length}, Number of records: ${records.length}`);

		const processBatch = async (batch: SendMessageBatchRequestEntry[], index: number) => {
			logger.info(`Processing batch ${index}: ${batch.length} records`);
			try {
				const response = await sqs.send(
					new SendMessageBatchCommand({
						QueueUrl: overrideQueue ?? queueUrl,
						Entries: batch,
					})
				);
				return response;
			} catch (error) {
				logger.error(`Error in SQS PutRecords: ${error}`);
				throw error;
			}
		};

		try {
			const results = await Promise.all(
				batches.map((batch, index) => limiter.schedule(() => processBatch(batch, index)))
			);

			const failedCount = results.reduce(
				(prev, result) => prev + (result.Failed?.length ?? 0),
				0
			);

			logger.info(
				`Sent ${records.length - failedCount} records to SQS. Failed ${failedCount}`
			);

			return { failedCount };
		} catch (error) {
			logger.error(`Error in putRecords operation: ${error}`);
			throw error;
		}
	};

	const getMessages = async (
		options: {
			maxMessages?: number;
			waitTimeSeconds?: number;
			visibilityTimeout?: number;
		} = {}
	) => {
		const { maxMessages = 10, waitTimeSeconds = 20, visibilityTimeout = 30 } = options;

		try {
			const response = await sqs.send(
				new ReceiveMessageCommand({
					QueueUrl: queueUrl,
					MaxNumberOfMessages: maxMessages,
					WaitTimeSeconds: waitTimeSeconds,
					VisibilityTimeout: visibilityTimeout,
					MessageSystemAttributeNames: ['ApproximateReceiveCount'],
				})
			);

			logger.info(`Retrieved ${response.Messages?.length ?? 0} messages from queue`);
			return response.Messages || [];
		} catch (error) {
			logger.error(`Error getting messages from queue: ${error}`);
			throw error;
		}
	};

	const deleteMessages = async (
		entries: DeleteMessageBatchRequestEntry[]
	): Promise<DeleteMessageBatchRequestEntry[]> => {
		try {
			const batches = batchArray(entries, 10);
			logger.info(
				`Number of batches: ${batches.length}, Number of records: ${entries.length}`
			);

			const responses = await Promise.all(
				batches.map((batchEntries) =>
					limiter.schedule(() =>
						sqs.send(
							new DeleteMessageBatchCommand({
								QueueUrl: queueUrl,
								Entries: batchEntries,
							})
						)
					)
				)
			);

			const failedMessageIds = new Set(
				responses.flatMap((response) => response.Failed?.map((f) => f.Id) ?? [])
			);

			const failedMessages = entries.filter((entry) => failedMessageIds.has(entry.Id));

			if (failedMessages.length > 0) {
				logger.warn(`Failed to delete ${failedMessages.length} messages from queue`, true);
			}

			logger.info(
				`Successfully deleted ${entries.length - failedMessages.length} messages from queue`
			);

			return failedMessages;
		} catch (error) {
			logger.error(`Error deleting messages from queue: ${error}`);
			throw error;
		}
	};

	return {
		putMessages,
		getMessages,
		deleteMessages,
	};
};
