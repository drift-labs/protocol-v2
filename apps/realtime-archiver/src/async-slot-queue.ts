import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { logger, SlotStatus } from '@backend/common';
import { FAILED_PK, MISSED_PK } from '@backend/dynamodb';
import { SQS } from '@backend/sqs';
import { DynamoDBStreamEvent } from 'aws-lambda';

export const handler = async (event: DynamoDBStreamEvent) => {
	const { putMessages } = SQS();
	const records = [];

	for (const record of event.Records) {
		if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;

		if (!record.dynamodb || !record.dynamodb.NewImage) {
			logger.info(`Skipping record ${record.eventID}: dynamodb or NewImage is undefined`);
			continue;
		}

		const newImage = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);

		logger.info(`Adding slot:${newImage.slot} to the queue`);

		if (
			(newImage.pk === MISSED_PK && newImage.status === SlotStatus.MISSED) ||
			(newImage.pk === FAILED_PK && newImage.status === SlotStatus.FAILED)
		) {
			records.push({
				Id: record.eventID,
				MessageBody: JSON.stringify(newImage),
			});
		}
	}

	if (records.length) {
		await putMessages({ records });
	}
};
