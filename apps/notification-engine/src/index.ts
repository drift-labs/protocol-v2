import { unmarshall } from '@aws-sdk/util-dynamodb';
import { BaseDynamoRecord, DBRecord, logger, NotificationType } from '@backend/common';
import { SNSMessage, SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { AccountProcessor } from './processors/account-processor';
import { PriceProcessor } from './processors/price-processor';
import { RecordProcessor } from './processors/record-processor';
import { MessageBody } from './types';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const { processPriceUpdate } = PriceProcessor();
	const { processAccount } = AccountProcessor();
	const { processRecord } = RecordProcessor();
	const batchItemFailures: SQSBatchItemFailure[] = [];

	const parseMessageBody = (record: SQSRecord): MessageBody => {
		try {
			const message: SNSMessage = JSON.parse(record.body);
			if (message.Message) {
				return JSON.parse(message.Message);
			}
			return JSON.parse(record.body);
		} catch (error) {
			throw new Error('Invalid message format');
		}
	};

	const processMessage = async (record: SQSRecord): Promise<void> => {
		const messageBody = parseMessageBody(record);
		logger.info(`Processing message type: ${messageBody.type}`);

		switch (messageBody.type) {
			case NotificationType.PRICE_ALERT: {
				await processPriceUpdate(messageBody.data);
				break;
			}
			case NotificationType.RECORD_UPDATE: {
				await processRecord(unmarshall(messageBody.data) as DBRecord & BaseDynamoRecord);
				break;
			}
			case NotificationType.ACCOUNT_UPDATE: {
				await processAccount(messageBody.data);
				break;
			}
			default: {
				throw new Error(`Unsupported message type: ${JSON.stringify(messageBody)}`);
			}
		}
	};

	await Promise.all(
		event.Records.map(async (record) => {
			try {
				await processMessage(record);
			} catch (error) {
				const { message } = error as Error;

				if (parseInt(record.attributes.ApproximateReceiveCount) == 3) {
					logger.error(
						`Error processing message:${record.messageId}, attempts:${record.attributes.ApproximateReceiveCount}: ${message}`
					);
				}

				batchItemFailures.push({
					itemIdentifier: record.messageId,
				});
			}
		})
	);

	return {
		batchItemFailures,
	};
};
