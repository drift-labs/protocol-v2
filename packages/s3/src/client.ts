import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	ListObjectsV2CommandOutput,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry';
import { DEFAULT_S3_BUCKET, logger } from '@backend/common';
import Bottleneck from 'bottleneck';
import { PassThrough, Readable, Writable } from 'stream';
import { promisify } from 'util';
import { createGunzip, createGzip, gunzip, gzip } from 'zlib';

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

const limiter = new Bottleneck({
	maxConcurrent: 1,
});
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

const s3Endpoint = process.env.S3_ENDPOINT_URL ?? process.env.AWS_ENDPOINT_URL;
const s3 = new S3Client({
	...(s3Endpoint ? { endpoint: s3Endpoint, forcePathStyle: true } : {}),
	retryStrategy: new ConfiguredRetryStrategy(5, (attempt: number) => 100 + attempt * 500),
});

export const S3 = ({ overrideBucketName }: { overrideBucketName?: string } = {}) => {
	const bucketName = overrideBucketName ?? process.env.S3_BUCKET ?? DEFAULT_S3_BUCKET;

	const listObjects = async (prefix: string, options?: { startAfter?: string }) => {
		try {
			const response: ListObjectsV2CommandOutput = await s3.send(
				new ListObjectsV2Command({
					Bucket: bucketName,
					Prefix: prefix,
					StartAfter: options?.startAfter,
				})
			);
			return response.Contents?.filter((object) => object.Size !== 0) || [];
		} catch (error) {
			logger.error(`Error listing objects: ${error}`);
			throw error;
		}
	};

	const listAllObjects = async (prefix: string, options?: { startAfter?: string }) => {
		try {
			const objects: { Key?: string; Size?: number }[] = [];
			let continuationToken: string | undefined = undefined;

			do {
				const response: ListObjectsV2CommandOutput = await s3.send(
					new ListObjectsV2Command({
						Bucket: bucketName,
						Prefix: prefix,
						...(continuationToken ? { ContinuationToken: continuationToken } : {}),
						...(!continuationToken && options?.startAfter
							? { StartAfter: options.startAfter }
							: {}),
					})
				);

				objects.push(...(response.Contents?.filter((object) => object.Size !== 0) || []));
				continuationToken = response.IsTruncated
					? response.NextContinuationToken
					: undefined;
			} while (continuationToken);

			return objects;
		} catch (error) {
			logger.error(`Error listing objects: ${error}`);
			throw error;
		}
	};

	const listKeys = async (
		prefix: string,
		options: { startAfter: string | undefined; delimiter: string } = {
			startAfter: undefined,
			delimiter: '/',
		}
	) => {
		try {
			const response: ListObjectsV2CommandOutput = await s3.send(
				new ListObjectsV2Command({
					Bucket: bucketName,
					Prefix: prefix,
					StartAfter: options.startAfter,
					Delimiter: options.delimiter,
				})
			);
			return response.CommonPrefixes?.map((object) => object.Prefix) || [];
		} catch (error) {
			logger.error(`Error listing objects: ${error}`);
			throw error;
		}
	};

	const getObject = async (key: string) => {
		const command = new GetObjectCommand({
			Bucket: bucketName,
			Key: key,
		});

		try {
			const response = await s3.send(command);
			if (!response.Body) {
				throw new Error(`No body in response for key: ${key}`);
			}

			const content = await response.Body.transformToByteArray();

			if (key.endsWith('.gz')) {
				const decompressed = await gunzipAsync(content);
				return decompressed.toString();
			} else {
				return Buffer.from(content).toString();
			}
		} catch (error) {
			logger.warn(`Error getting object ${key}: ${error}`);
			throw error;
		}
	};

	const getObjectStream = async (key: string): Promise<Readable> => {
		const command = new GetObjectCommand({
			Bucket: bucketName,
			Key: key,
		});

		try {
			const response = await s3.send(command);
			if (!response.Body) {
				throw new Error(`No body in response for key: ${key}`);
			}

			const body = response.Body as Readable;
			return key.endsWith('.gz') ? body.pipe(createGunzip()) : body;
		} catch (error) {
			logger.warn(`Error getting object stream ${key}: ${error}`);
			throw error;
		}
	};

	const putObject = async (key: string, body: string) => {
		const compressedContent = await gzipAsync(body);
		const command = new PutObjectCommand({
			Bucket: bucketName,
			Key: key,
			Body: compressedContent,
		});

		try {
			await s3.send(command);
			logger.info(`Successfully put object: ${key}`);
		} catch (error) {
			logger.error(`Error putting object ${key}: ${error}`);
			throw error;
		}
	};

	const putObjectStream = async (key: string, writer: (stream: Writable) => Promise<void>) => {
		const source = new PassThrough();
		const compressedStream = source.pipe(createGzip());
		let uploadId: string | undefined;
		let partNumber = 1;
		const completedParts: { ETag?: string; PartNumber: number }[] = [];
		let buffered = Buffer.alloc(0);

		try {
			const createResponse = await s3.send(
				new CreateMultipartUploadCommand({
					Bucket: bucketName,
					Key: key,
				})
			);

			uploadId = createResponse.UploadId;
			if (!uploadId) {
				throw new Error(`Failed to create multipart upload for ${key}`);
			}

			const uploadPart = async (body: Buffer) => {
				const response = await s3.send(
					new UploadPartCommand({
						Bucket: bucketName,
						Key: key,
						UploadId: uploadId,
						PartNumber: partNumber,
						Body: body,
						ContentLength: body.length,
					})
				);

				completedParts.push({
					ETag: response.ETag,
					PartNumber: partNumber,
				});
				partNumber++;
			};

			const writerPromise = (async () => {
				try {
					await writer(source);
					source.end();
				} catch (error) {
					source.destroy(error as Error);
					throw error;
				}
			})();

			for await (const chunk of compressedStream) {
				buffered = Buffer.concat([buffered, Buffer.from(chunk)]);

				while (buffered.length >= MULTIPART_PART_SIZE) {
					await uploadPart(buffered.subarray(0, MULTIPART_PART_SIZE));
					buffered = buffered.subarray(MULTIPART_PART_SIZE);
				}
			}

			await writerPromise;

			if (buffered.length > 0 || completedParts.length === 0) {
				await uploadPart(buffered);
			}

			await s3.send(
				new CompleteMultipartUploadCommand({
					Bucket: bucketName,
					Key: key,
					UploadId: uploadId,
					MultipartUpload: {
						Parts: completedParts,
					},
				})
			);
			logger.info(`Successfully streamed object: ${key}`);
		} catch (error) {
			source.destroy(error as Error);
			if (uploadId) {
				try {
					await s3.send(
						new AbortMultipartUploadCommand({
							Bucket: bucketName,
							Key: key,
							UploadId: uploadId,
						})
					);
				} catch (abortError) {
					logger.error(`Error aborting multipart upload ${key}: ${abortError}`);
				}
			}
			logger.error(`Error streaming object ${key}: ${error}`);
			throw error;
		}
	};

	const moveObject = async (sourceKey: string, destinationKey: string) => {
		const copyCommand = new CopyObjectCommand({
			Bucket: bucketName,
			CopySource: `${bucketName}/${sourceKey}`,
			Key: destinationKey,
		});

		const deleteCommand = new DeleteObjectCommand({
			Bucket: bucketName,
			Key: sourceKey,
		});

		try {
			await s3.send(copyCommand);
			await s3.send(deleteCommand);
			logger.info(`Successfully moved object from ${sourceKey} to ${destinationKey}`);
		} catch (error) {
			logger.error(`Error moving object from ${sourceKey} to ${destinationKey}: ${error}`);
			throw error;
		}
	};

	const copyObject = async (sourceKey: string, destinationKey: string) => {
		const command = new CopyObjectCommand({
			Bucket: bucketName,
			CopySource: `${bucketName}/${sourceKey}`,
			Key: destinationKey,
		});

		try {
			await s3.send(command);
		} catch (error) {
			logger.error(`Error copying object from ${sourceKey} to ${destinationKey}: ${error}`);
			throw error;
		}
	};

	const deleteObject = async (key: string) => {
		const command = new DeleteObjectCommand({
			Bucket: bucketName,
			Key: key,
		});

		try {
			await s3.send(command);
		} catch (error) {
			logger.error(`Error deleting object ${key}: ${error}`);
			throw error;
		}
	};

	const processFiles = async (
		unprocessedPrefix: string,
		processedPrefix: string,
		processor: (content: string, key: string) => Promise<void[]>
	) => {
		const files = await listObjects(unprocessedPrefix);

		const processFile = async (file: { Key?: string }) => {
			if (!file.Key) return;
			try {
				const content = await getObject(file.Key);
				await processor(content, file.Key);
				const newKey = file.Key.replace(unprocessedPrefix, processedPrefix);
				await moveObject(file.Key, newKey);
			} catch (error) {
				logger.error(`Error processing file ${file.Key}: ${error}`);
			}
		};

		await Promise.all(files.map((file) => limiter.schedule(() => processFile(file))));
	};

	return {
		getObject,
		getObjectStream,
		putObject,
		putObjectStream,
		listObjects,
		listAllObjects,
		listKeys,
		moveObject,
		copyObject,
		deleteObject,
		processFiles,
	};
};
