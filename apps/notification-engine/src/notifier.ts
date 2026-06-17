import { unmarshall } from '@aws-sdk/util-dynamodb';
import { logger, NotificationRecord } from '@backend/common';
import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { processNotification, registerAllProviders } from './providers';

registerAllProviders();

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	logger.info(`Processing ${event.Records.length} notification messages`);
	const batchItemFailures: SQSBatchItemFailure[] = [];

	const results = await Promise.allSettled(
		event.Records.map(async (record) => {
			try {
				const { data } = JSON.parse(record.body);
				const notification = unmarshall(data) as NotificationRecord;
				await processNotification(notification);
			} catch (error) {
				logger.error(
					`Error processing record ${record.messageId}: ${(error as Error).message}`
				);
				batchItemFailures.push({ itemIdentifier: record.messageId });
			}
		})
	);

	const successes = results.filter((r) => r.status === 'fulfilled').length;
	logger.info(
		`Processed ${event.Records.length} notification messages - Success: ${
			successes - batchItemFailures.length
		}, Failed: ${batchItemFailures.length}`
	);

	return { batchItemFailures };
};
