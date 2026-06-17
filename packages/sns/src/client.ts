import {
	PublishBatchCommand,
	PublishBatchRequestEntry,
	PublishCommand,
	SNSClient,
} from '@aws-sdk/client-sns';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import { batchArray, logger } from '@backend/common';
import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
	maxConcurrent: 5,
});

const snsEndpoint = process.env.SNS_ENDPOINT_URL ?? process.env.AWS_ENDPOINT_URL;
const sns = new SNSClient({
	...(snsEndpoint ? { endpoint: snsEndpoint } : {}),
	retryStrategy: new ConfiguredRetryStrategy(5, (attempt: number) => 100 + attempt * 500),
});

export const SNS = () => {
	const publishMessages = async ({
		records,
		topicArn,
	}: {
		records: PublishBatchRequestEntry[];
		topicArn: string;
	}) => {
		const batchSize = 10;
		const batches = batchArray(records, batchSize);

		logger.info(`Number of batches: ${batches.length}, Number of records: ${records.length}`);

		const processBatch = async (batch: PublishBatchRequestEntry[], index: number) => {
			logger.info(`Processing batch ${index}: ${batch.length} records`);
			try {
				const response = await sns.send(
					new PublishBatchCommand({
						TopicArn: topicArn,
						PublishBatchRequestEntries: batch,
					})
				);
				return response;
			} catch (error) {
				logger.error(`Error in SNS PublishBatch: ${error}`);
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
				`Published ${records.length - failedCount} messages to SNS. Failed ${failedCount}`
			);

			return { failedCount };
		} catch (error) {
			logger.error(`Error in publishMessages operation: ${error}`);
			throw error;
		}
	};

	const publishMessage = async ({
		message,
		topicArn,
		subject,
		messageAttributes,
		messageGroupId,
		messageDeduplicationId,
	}: {
		message: string;
		topicArn: string;
		subject?: string;
		messageAttributes?: Record<
			string,
			{
				DataType: string;
				StringValue?: string;
				BinaryValue?: Uint8Array;
			}
		>;
		messageGroupId?: string;
		messageDeduplicationId?: string;
	}) => {
		try {
			const response = await sns.send(
				new PublishCommand({
					TopicArn: topicArn,
					Message: message,
					Subject: subject,
					MessageAttributes: messageAttributes,
					MessageGroupId: messageGroupId,
					MessageDeduplicationId: messageDeduplicationId,
				})
			);
			logger.info(`Published message to SNS: ${response.MessageId}`);
			return response;
		} catch (error) {
			logger.error(`Error publishing message to SNS: ${error}`);
			throw error;
		}
	};

	return {
		publishMessages,
		publishMessage,
	};
};
