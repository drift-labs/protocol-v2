import { EntityTypes, IngestionSource, logger, sleep } from '@backend/common';
import { S3 } from '@backend/s3';
import Bottleneck from 'bottleneck';
import { Archiver } from './services/archive';
import { createHealthServer } from './services/health';

const UNPROCESSED_PREFIX = `unprocessed/source=${IngestionSource.SEQUENTIAL}`;
const PROCESSED_PREFIX = `processed_files/source=${IngestionSource.SEQUENTIAL}`;
const LOOP_DELAY_MS = 10000;

const limiter = new Bottleneck({
	maxConcurrent: 25,
});

export const main = async () => {
	createHealthServer('archiver');

	logger.info('Starting continuous S3 file processing');

	const { processFiles } = S3();
	const {
		getRecords,
		sortRecords,
		processType,
		getRecordPathName,
		destructureKey,
		flushLargeUserCache,
	} = Archiver();

	const loop = true;
	while (loop) {
		try {
			logger.info('Beginning processing cycle');

			const processor = async (content: string, key: string) => {
				const records = getRecords({ content });
				const sortedRecords = sortRecords({ records });

				const { eventType, year, month, day } = destructureKey(key);

				if (!eventType || !year || !month) {
					throw new Error(`Failed to extract eventType, year, or month from key: ${key}`);
				}

				return Promise.all(
					Object.entries(sortedRecords).map(async ([type, sortedRecords]) => {
						switch (type) {
							case EntityTypes.User: {
								await Promise.all(
									Object.entries(sortedRecords).map(([userId, records]) =>
										limiter.schedule(async () => {
											const key = getRecordPathName({
												id: userId,
												eventType,
												year,
												month,
											});
											await processType({ key, records });
										})
									)
								);
								break;
							}
							case EntityTypes.Authority: {
								await Promise.all(
									Object.entries(sortedRecords).map(([authorityId, records]) =>
										limiter.schedule(async () => {
											const key = getRecordPathName({
												entity: EntityTypes.Authority,
												id: authorityId,
												eventType,
												year,
												month,
												day,
											});
											await processType({ key, records });
										})
									)
								);
								break;
							}
							case EntityTypes.Market: {
								await Promise.all(
									Object.entries(sortedRecords).map(([marketName, records]) =>
										limiter.schedule(async () => {
											const key = getRecordPathName({
												entity: EntityTypes.Market,
												id: marketName,
												eventType,
												year,
												month,
												day,
											});
											await processType({ key, records });
										})
									)
								);
								break;
							}
						}
					})
				);
			};

			await processFiles(UNPROCESSED_PREFIX, PROCESSED_PREFIX, processor);

			logger.info('Completed processing cycle');
		} catch (error) {
			const { message } = error as Error;
			logger.error(`Error in processing cycle: ${message}`);
			throw error;
		}

		logger.info(`Waiting for ${LOOP_DELAY_MS / 1000} seconds before next cycle`);
		flushLargeUserCache();
		await sleep(LOOP_DELAY_MS);
	}
};

if (process.env.NODE_ENV !== 'test') {
	main().catch((error) => {
		logger.error(`Unhandled error in main: ${error.message}`);
		process.exit(1);
	});
}
