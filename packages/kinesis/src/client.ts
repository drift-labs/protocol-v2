import {
	GetRecordsCommand,
	GetRecordsCommandOutput,
	GetShardIteratorCommand,
	KinesisClient,
	PutRecordCommand,
	PutRecordsCommand,
	PutRecordsRequestEntry,
	ShardIteratorType,
} from '@aws-sdk/client-kinesis';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import { DEFAULT_KINESIS_STREAM, batchArray, logger } from '@backend/common';
import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
	maxConcurrent: 5,
});

const kinesisEndpoint = process.env.KINESIS_ENDPOINT_URL ?? process.env.AWS_ENDPOINT_URL;
const kinesis = new KinesisClient({
	...(kinesisEndpoint ? { endpoint: kinesisEndpoint } : {}),
	retryStrategy: new ConfiguredRetryStrategy(5, (attempt: number) => 100 + attempt * 500),
});

export const Kinesis = ({
	overrideStreamName,
}: {
	overrideStreamName?: string;
} = {}) => {
	const stream = overrideStreamName || process.env.KINESIS_STREAM || DEFAULT_KINESIS_STREAM;

	const putRecord = async ({ data, partitionKey }: { data: string; partitionKey: string }) => {
		return kinesis.send(
			new PutRecordCommand({
				StreamName: stream,
				Data: Buffer.from(data),
				PartitionKey: partitionKey,
			})
		);
	};

	const putRecords = async (records: PutRecordsRequestEntry[]) => {
		const batchSize = 500; // Kinesis PutRecords API limit
		const batches = batchArray(records, batchSize);

		logger.info(`Number of batches: ${batches.length}, Number of records: ${records.length}`);

		const processBatch = async (batch: PutRecordsRequestEntry[], index: number) => {
			logger.info(`Processing batch ${index}: ${batch.length} records`);
			try {
				const response = await kinesis.send(
					new PutRecordsCommand({
						StreamName: stream,
						Records: batch,
					})
				);
				return response;
			} catch (error) {
				logger.error(`Error in Kinesis PutRecords: ${error}`);
				throw error;
			}
		};

		try {
			const results = await Promise.all(
				batches.map((batch, index) => limiter.schedule(() => processBatch(batch, index)))
			);

			const failedCount = results.reduce(
				(prev, result) => prev + (result.FailedRecordCount ?? 0),
				0
			);

			logger.info(
				`Sent ${records.length - failedCount} records to kinesis. Failed ${failedCount}`
			);

			return { failedCount };
		} catch (error) {
			logger.error(`Error in putRecords operation: ${error}`);
			throw error;
		}
	};

	const getRecordsFromSequence = async ({
		shardId,
		startSequenceNumber,
		endSequenceNumber,
		limit = 1000,
	}: {
		shardId: string;
		startSequenceNumber: string;
		endSequenceNumber: string;
		limit?: number;
	}): Promise<GetRecordsCommandOutput[]> => {
		try {
			logger.info(
				`Fetching and decoding records from sequence start: ${startSequenceNumber}, end: ${endSequenceNumber}`
			);

			const iteratorResponse = await kinesis.send(
				new GetShardIteratorCommand({
					StreamName: stream,
					ShardId: shardId,
					ShardIteratorType: ShardIteratorType.AT_SEQUENCE_NUMBER,
					StartingSequenceNumber: startSequenceNumber,
				})
			);

			if (!iteratorResponse.ShardIterator) {
				throw new Error('Failed to get shard iterator');
			}

			const decodedRecords = [];
			let currentShardIterator: string | undefined = iteratorResponse.ShardIterator;
			let reachedEnd = false;

			while (!reachedEnd && currentShardIterator) {
				const recordsResponse: GetRecordsCommandOutput = await kinesis.send(
					new GetRecordsCommand({
						ShardIterator: currentShardIterator,
						Limit: limit,
					})
				);

				if (recordsResponse.Records) {
					for (const record of recordsResponse.Records) {
						try {
							if (record.Data) {
								const decodedRecord = decodeKinesisData(record);
								if (decodedRecord) {
									decodedRecords.push(decodedRecord);
								}
							}

							if (record.SequenceNumber === endSequenceNumber) {
								reachedEnd = true;
								break;
							}
						} catch (decodeError) {
							await logger.error(`Failed to decode record: ${decodeError}`);
						}
					}
				}

				currentShardIterator = recordsResponse.NextShardIterator;

				if (!currentShardIterator || recordsResponse.Records?.length === 0) {
					break;
				}
			}

			logger.info(`Successfully decoded ${decodedRecords.length} records`);
			return decodedRecords;
		} catch (error) {
			const { message } = error as Error;
			await logger.error(`Error fetching and decoding records: ${message}`);
			throw error;
		}
	};

	const decodeKinesisData = (record: any | { Data: Uint8Array }) => {
		try {
			const jsonString = Buffer.from(record.Data).toString('utf-8');
			return JSON.parse(jsonString);
		} catch (error) {
			console.error('Failed to decode with Buffer:', error);
		}
	};

	return {
		putRecord,
		putRecords,
		getRecordsFromSequence,
		decodeKinesisData,
	};
};
