import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { logger } from '@backend/common';
import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { buildStatement } from '../utils/user-exports/build-statement';
import { buildExportFileName, buildExportS3Key } from '../utils/user-exports/file-naming';
import { ExportJobRepository } from '../utils/user-exports/job-repository';
import { ExportMode, ExportQueueMessage, ExportStatus } from '../utils/user-exports/types';

const s3 = new S3Client({});

const outputBucketForMode = (mode: ExportMode): string => {
	const b =
		process.env[`${mode.toUpperCase()}_USER_EXPORTS_BUCKET`] ?? process.env.USER_EXPORTS_BUCKET;
	if (!b) {
		throw new Error(`USER_EXPORTS_BUCKET env var not set (mode=${mode})`);
	}
	return b;
};

const processRecord = async (record: SQSRecord): Promise<void> => {
	const msg: ExportQueueMessage = JSON.parse(record.body);
	const repo = ExportJobRepository(msg.mode);
	const job = await repo.getJob(msg.authority, msg.requestId, msg.createdAt);

	if (!job) {
		logger.warn(`Export job not found: ${msg.authority}/${msg.requestId} — dropping message`);
		return;
	}

	if (job.status !== ExportStatus.Pending) {
		logger.info(
			`Export job ${msg.requestId} already in status ${job.status}, skipping reprocess`
		);
		return;
	}

	try {
		await repo.markInProgress(msg.authority, msg.requestId, msg.createdAt);
	} catch (err) {
		// Conditional update failed — another worker already claimed it.
		logger.info(
			`Export job ${msg.requestId} could not be claimed (likely duplicate delivery): ${
				(err as Error).message
			}`
		);
		return;
	}

	const outputBucket = outputBucketForMode(msg.mode);

	try {
		const { gzipped, recordCount, isEmpty } = await buildStatement({
			mode: msg.mode,
			fileType: job.fileType,
			authority: job.authority,
			userPublicKeys: job.userPublicKeys,
			from: job.from,
			to: job.to,
			market: job.market,
		});

		const fileName = buildExportFileName({
			fileType: job.fileType,
			userPublicKeys: job.userPublicKeys,
			from: job.from,
			to: job.to,
			requestedAt: job.createdAt,
			market: job.market,
			isEmpty,
		});
		const s3Key = buildExportS3Key({ authority: job.authority, fileName });

		if (!isEmpty) {
			await s3.send(
				new PutObjectCommand({
					Bucket: outputBucket,
					Key: s3Key,
					Body: gzipped,
					ContentType: 'text/csv',
					ContentEncoding: 'gzip',
				})
			);
		}

		await repo.markReady(msg.authority, msg.requestId, msg.createdAt, s3Key, recordCount);
		logger.info(
			`Export ${msg.requestId} ready (${msg.mode}): ${recordCount} records, s3://${outputBucket}/${s3Key}`
		);
	} catch (err) {
		const reason = (err as Error).message;
		logger.error(`Export ${msg.requestId} failed: ${reason}`);
		await repo.markFailed(msg.authority, msg.requestId, msg.createdAt, reason);
		throw err;
	}
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const batchItemFailures: SQSBatchItemFailure[] = [];

	await Promise.all(
		event.Records.map(async (record) => {
			try {
				await processRecord(record);
			} catch (err) {
				logger.error(
					`Export worker record ${record.messageId} failed: ${(err as Error).message}`
				);
				batchItemFailures.push({ itemIdentifier: record.messageId });
			}
		})
	);

	return { batchItemFailures };
};
