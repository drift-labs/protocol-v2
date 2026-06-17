import {
	isFeatureEnabled,
	logger,
	parseSQSMessageFromDynamoEvent,
	TradeRecord,
} from '@backend/common';
import { SQS } from '@backend/sqs';
import { backOff } from 'exponential-backoff';
import { Scheduler } from '../services/scheduler';
import { processLeaderboard, verifyLeaderboard } from '../tasks/leaderboard';
import { processVolume } from '../tasks/volume';

const { getMessages, deleteMessages } = SQS();

export const processTradePipeline = async (trade: TradeRecord) => {
	const steps = [
		{ name: 'processVolume', fn: processVolume },
		...(isFeatureEnabled('LEADERBOARD', true)
			? [{ name: 'processLeaderboard', fn: processLeaderboard }]
			: []),
	];

	const results = await Promise.allSettled(
		steps.map(async (step) => {
			const backoffOptions = {
				numOfAttempts: 3,
				startingDelay: 500,
				timeMultiple: 2,
				maxDelay: 5000,
				delayFirstAttempt: false,
				retry: (error: Error, attemptNumber: number) => {
					logger.warn(
						`Step '${step.name}' attempt ${attemptNumber} failed for trade ${trade.fillRecordId}. Error: ${error.message}. Retrying...`
					);
					return true;
				},
			};

			return await backOff(() => step.fn(trade), backoffOptions);
		})
	);

	const allFailed = results.every((result) => result.status === 'rejected');
	if (allFailed) {
		throw new Error('All pipeline steps failed after retries');
	}

	// Log partial failures for monitoring with detailed step information
	const failures = results
		.map((result, index) => ({ result, step: steps[index] }))
		.filter(({ result }) => result.status === 'rejected');

	if (failures.length > 0) {
		const failedStepNames = failures.map(({ step }) => step.name);
		const failureDetails = failures.map(({ step, result }) => {
			const reason = result.status === 'rejected' ? result.reason : 'Unknown error';
			return `${step.name}: ${reason}`;
		});

		logger.warn(
			`Partial pipeline failure for trade ${trade.fillRecordId}: ` +
				`${failures.length}/${steps.length} steps failed after retries. ` +
				`Failed steps: [${failedStepNames.join(', ')}]. ` +
				`Details: ${failureDetails.join('; ')}`,
			true
		);
	}
};

export const processBatch = async () => {
	try {
		const messages = await getMessages({ maxMessages: 10 });
		if (!messages?.length) return;

		const messageResults = await Promise.allSettled(
			messages.map(async (message) => {
				const trade = parseSQSMessageFromDynamoEvent<TradeRecord>(message.Body);
				if (!trade) {
					return {
						messageId: message.MessageId,
						success: false,
						reason: 'No trade data found',
					};
				}

				try {
					await processTradePipeline(trade);
					return {
						messageId: message.MessageId,
						receiptHandle: message.ReceiptHandle,
						success: true,
					};
				} catch (error) {
					await logger.error(
						`Error processing trade message ${message.MessageId}: ${error}`
					);
					return {
						messageId: message.MessageId,
						success: false,
						reason: error,
					};
				}
			})
		);

		const successfulDeletes = messageResults
			.filter((result) => result.status === 'fulfilled' && result.value.success)
			.map((result) => ({
				Id: (result as PromiseFulfilledResult<any>).value.messageId,
				ReceiptHandle: (result as PromiseFulfilledResult<any>).value.receiptHandle,
			}));

		if (successfulDeletes.length > 0) {
			const deleteBackoffOptions = {
				numOfAttempts: 3,
				startingDelay: 200,
				timeMultiple: 2,
				maxDelay: 2000,
				delayFirstAttempt: false,
				retry: (error: Error, attemptNumber: number) => {
					logger.warn(
						`Delete messages attempt ${attemptNumber} failed. Error: ${error.message}. Retrying...`
					);
					return true;
				},
			};

			try {
				const deleteWithRetry = async (messagesToDelete: typeof successfulDeletes) => {
					const failedMessages = await deleteMessages(messagesToDelete);
					if (failedMessages.length > 0) {
						throw new Error(`Failed to delete ${failedMessages.length} messages`);
					}
					return failedMessages;
				};

				await backOff(() => deleteWithRetry(successfulDeletes), deleteBackoffOptions);
				logger.info(
					`Successfully processed and deleted ${successfulDeletes.length} messages`
				);
			} catch (error) {
				const { message } = error as Error;
				logger.error(`Failed to delete some messages after retries: ${message}`);
			}
		}

		const failedCount = messageResults.length - successfulDeletes.length;

		if (failedCount > 0) {
			logger.warn(`${failedCount} messages failed processing and will be retried`);
		}
	} catch (error) {
		await logger.error(`Error fetching or processing trade messages: ${error}`);
	}
};

export const setupTradePipeline = async ({
	scheduler,
}: {
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	logger.info('Starting Trade Pipeline Processor...');

	scheduler.scheduleTask('leaderboard-verification', '30 0 * * *', async () => {
		await verifyLeaderboard();
	});

	const loop = true;
	while (loop) {
		await processBatch();
	}
};
