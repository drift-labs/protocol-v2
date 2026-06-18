import {
	KinesisClient,
	PutRecordsCommand,
	PutRecordsRequestEntry,
} from '@aws-sdk/client-kinesis';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import { logger } from '../utils/logger';
import { CounterValue } from '../core/metricsV2';

type EventType = 'DLOBSnapshot' | 'DLOBL3Snapshot';

interface QueueMessage {
	data: any;
}

interface ThrottleInfo {
	lastSentTime: number;
}

const kinesis = new KinesisClient({
	retryStrategy: new ConfiguredRetryStrategy(
		5,
		(attempt: number) => 100 + attempt * 500
	),
});

const kinesisStream = process.env.KINESIS_STREAM_NAME;
const batchInterval = process.env.KINESIS_BATCH_INTERVAL
	? parseInt(process.env.KINESIS_BATCH_INTERVAL)
	: 10000;

export const OffloadQueue = (offloadQueueCounter?: CounterValue) => {
	const queue: QueueMessage[] = [];
	const throttleMap: Map<string, ThrottleInfo> = new Map();
	let isProcessing = false;

	setInterval(async () => {
		if (!isProcessing && queue.length > 0) {
			await processQueue();
		}
	}, batchInterval);

	const processQueue = async (): Promise<void> => {
		if (isProcessing || queue.length === 0) {
			return;
		}

		isProcessing = true;

		try {
			const batch = queue.splice(0, 500); // Kinesis limit

			const records: PutRecordsRequestEntry[] = batch.map((msg) => ({
				Data: Buffer.from(
					JSON.stringify({
						...msg.data,
						source: 'dlob',
					})
				),
				PartitionKey: Date.now().toString(),
			}));

			const command = new PutRecordsCommand({
				StreamName: kinesisStream,
				Records: records,
			});

			const response = await kinesis.send(command);

			if (response.FailedRecordCount && response.FailedRecordCount > 0) {
				logger.warn(`${response.FailedRecordCount} records failed to send`);

				const failedMessages: QueueMessage[] = [];
				response.Records?.forEach((record, index) => {
					if (record.ErrorCode) {
						failedMessages.push(batch[index]);
						logger.error(
							`Record ${index} failed: ${record.ErrorCode} - ${record.ErrorMessage}`
						);
					}
				});

				queue.unshift(...failedMessages);
			}

			const successCount = batch.length - (response.FailedRecordCount || 0);
			if (offloadQueueCounter) {
				offloadQueueCounter.add(successCount, {
					stream: kinesisStream,
				});
			}
		} catch (error) {
			logger.error('Error processing queue:', error);
		} finally {
			isProcessing = false;
		}
	};

	const shouldSendThrottled = (
		marketKey: string,
		currentTime: number
	): boolean => {
		const throttleInfo = throttleMap.get(marketKey);
		const lastSent = throttleInfo?.lastSentTime || 0;
		const timeSinceLastSent = currentTime - lastSent;

		if (timeSinceLastSent >= 60000) {
			throttleMap.set(marketKey, { lastSentTime: currentTime });
			return true;
		}

		if (timeSinceLastSent >= 45000) {
			const timeInWindow = timeSinceLastSent - 45000;
			const probability = Math.min(timeInWindow / 22500, 0.8);

			if (Math.random() < probability) {
				throttleMap.set(marketKey, { lastSentTime: currentTime });
				return true;
			}
		}

		return false;
	};

	const addMessage = (
		data: any,
		options: {
			eventType?: EventType;
			throttle?: boolean;
		} = {}
	) => {
		const { eventType = 'DLOBSnapshot', throttle = false } = options;
		const currentTime = Date.now();

		if (!throttle) {
			queue.push({
				data: {
					...data,
					eventType,
				},
			});
			return;
		}

		const marketKey = `${data.marketType}_${data.marketIndex}`;
		if (shouldSendThrottled(marketKey, currentTime)) {
			queue.push({
				data: {
					...data,
					eventType,
				},
			});
		}
	};

	return {
		addMessage,
	};
};
