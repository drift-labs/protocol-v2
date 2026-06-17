import { IngestionSource, logger, RecordIngestionFailure } from '@backend/common';
import { RealTimeArchiverRepository } from '@backend/dynamodb';
import { Kinesis } from '@backend/kinesis';
import { SQS } from '@backend/sqs';

const BATCH_SIZE = 10;
const MAX_PARALLEL_BATCHES = Number(process.env.MAX_PARALLEL_BATCHES) || 5;

export const DLQProcessor = ({ isRunning }: { isRunning: boolean }) => {
	const { getMessages, deleteMessages } = SQS({
		overrideQueueUrl:
			'https://sqs.eu-west-1.amazonaws.com/875427118836/mainnet-beta-record-ingestion-dlq',
	});
	const { getRecordsFromSequence } = Kinesis();
	const { createFailedSlotRecords } = RealTimeArchiverRepository();

	const processBatch = async () => {
		try {
			const messages = await getMessages({ maxMessages: BATCH_SIZE });
			if (!messages?.length) {
				logger.info('No messages received');
				return;
			}

			const deletedMessageIds: string[] = [];

			await Promise.all(
				messages.map(async (message) => {
					try {
						const body = JSON.parse(message.Body ?? '{}');
						if (body.error === RecordIngestionFailure.INSERT) {
							if (body.record.source === IngestionSource.GRPC) {
								deletedMessageIds.push(message.MessageId!);
								return;
							}
							if (body.record) {
								await createFailedSlotRecords([body.record.slot]);
								deletedMessageIds.push(message.MessageId!);
							}
						} else {
							const records = await getRecordsFromSequence({
								shardId: body.KinesisBatchInfo.shardId,
								startSequenceNumber: body.KinesisBatchInfo.startSequenceNumber,
								endSequenceNumber: body.KinesisBatchInfo.endSequenceNumber,
							});

							const uniqueSlots = new Set<number>();

							records.forEach((record: any) => {
								if (record.source === IngestionSource.GRPC) {
									return;
								}
								if (record.slot !== undefined) {
									uniqueSlots.add(record.slot);
								}
							});

							const failedSlotArray = [...uniqueSlots];

							logger.info(
								`Adding slots to failed: ${JSON.stringify(failedSlotArray)}`
							);

							await createFailedSlotRecords(failedSlotArray);

							deletedMessageIds.push(message.MessageId!);
						}
					} catch (error) {
						logger.error(
							`Error processing message ${message.MessageId}: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				})
			);

			const messagesToDelete = messages
				.filter((msg) => msg.MessageId && deletedMessageIds.includes(msg.MessageId))
				.map((msg) => ({
					Id: msg.MessageId!,
					ReceiptHandle: msg.ReceiptHandle!,
				}));

			if (messagesToDelete.length > 0) {
				await deleteMessages(messagesToDelete);
			}
		} catch (error) {
			const { message } = error as Error;
			await logger.error(`Error processing batch: ${message}`);
		}
	};

	const processParallelBatches = async () => {
		const batchPromises = Array(Number(MAX_PARALLEL_BATCHES))
			.fill(null)
			.map(() => processBatch());
		return Promise.all(batchPromises);
	};

	const stop = () => {
		isRunning = false;
		logger.info('Stopping processor after current batch completes...');
	};

	const start = async () => {
		logger.info('Starting DLQ processor...');
		while (isRunning) {
			await processParallelBatches();
		}
		logger.info('DLQ processor stopped');
	};

	return { start, stop, processBatch, processParallelBatches };
};
