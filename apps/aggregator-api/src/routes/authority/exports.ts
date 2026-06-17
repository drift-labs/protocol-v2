import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '@backend/common';
import { randomUUID } from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { solanaAuth } from '../../hooks/solana-auth';
import { metadataSchema } from '../../schemas';
import { SDK_MODE } from '../../sdk';
import { ExportJobRepository } from '../../utils/user-exports/job-repository';
import { ExportFileType, ExportQueueMessage, ExportStatus } from '../../utils/user-exports/types';

const SUBMIT_ACTION = 'requestExport';
const PRESIGN_EXPIRY_SECONDS = 60 * 60 * 8;
const MAX_RANGE_SECONDS = 366 * 24 * 60 * 60;

const sqs = new SQSClient({});
const s3 = new S3Client({});

type AuthorityParams = { authorityId: string };

type SubmitBody = {
	fileType: ExportFileType;
	from: number;
	to: number;
	userPublicKeys: string[];
	market?: string;
};

const exportRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const queueUrl = process.env.USER_EXPORTS_QUEUE_URL;
	const bucket = process.env.USER_EXPORTS_BUCKET;
	if (!queueUrl || !bucket) {
		throw new Error('USER_EXPORTS_QUEUE_URL and USER_EXPORTS_BUCKET env vars must be set');
	}

	const repo = ExportJobRepository(SDK_MODE);

	fastify.addHook('preHandler', solanaAuth);

	const authorityGate = (request: { walletAddress?: string; params: AuthorityParams }) => {
		const { authorityId } = request.params;
		return request.walletAddress === authorityId;
	};

	fastify.post<{
		Params: AuthorityParams;
		Body: SubmitBody;
	}>(
		'',
		{
			schema: {
				description:
					'<p>Submit a request to build a CSV statement for the given authority. The job is enqueued and processed asynchronously; poll <code>GET</code> on the same path to retrieve readiness and a presigned download URL.</p>',
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				body: {
					type: 'object',
					required: ['fileType', 'from', 'to', 'userPublicKeys'],
					additionalProperties: false,
					properties: {
						fileType: { type: 'string', enum: Object.values(ExportFileType) },
						from: { type: 'integer', minimum: 0 },
						to: { type: 'integer', minimum: 0 },
						userPublicKeys: {
							type: 'array',
							items: { type: 'string' },
							minItems: 1,
						},
						market: { type: 'string', nullable: true },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							requestId: { type: 'string' },
							status: { type: 'string' },
						},
					},
				},
			},
		},
		async function (request, reply) {
			if (!authorityGate(request)) {
				return reply.code(403).send({
					success: false,
					error: 'Signer is not authorised for this authority',
				});
			}

			const signedAction = JSON.parse(
				(request.headers['x-signed-message'] as string) ?? '{}'
			)?.action;
			if (signedAction !== SUBMIT_ACTION) {
				return reply.code(401).send({
					success: false,
					error: `Signed message action must be "${SUBMIT_ACTION}"`,
				});
			}

			const { fileType, from, to, userPublicKeys, market } = request.body;
			if (from >= to) {
				return reply
					.code(400)
					.send({ success: false, error: '`from` must be less than `to`' });
			}
			if (to - from > MAX_RANGE_SECONDS) {
				return reply.code(400).send({
					success: false,
					error: `Date range must be at most 366 days (got ${to - from} seconds)`,
				});
			}

			const requestId = randomUUID();
			const row = await repo.createJob({
				requestId,
				authority: request.params.authorityId,
				fileType,
				from,
				to,
				userPublicKeys,
				market,
			});

			const message: ExportQueueMessage = {
				requestId,
				authority: request.params.authorityId,
				createdAt: row.createdAt,
				mode: SDK_MODE,
			};
			await sqs.send(
				new SendMessageCommand({
					QueueUrl: queueUrl,
					MessageBody: JSON.stringify(message),
				})
			);

			return reply.send({ success: true, requestId, status: ExportStatus.Pending });
		}
	);

	fastify.get<{
		Params: AuthorityParams;
		Querystring: { page?: string };
	}>(
		'',
		{
			schema: {
				description:
					'<p>List export jobs for the given authority, newest first, 20 per page. Ready jobs include an 8 hour presigned <code>downloadUrl</code>. Use the <code>page</code> token from <code>meta.nextPage</code> to fetch subsequent pages.</p>',
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'string' },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										requestId: { type: 'string' },
										status: { type: 'string' },
										fileType: { type: 'string' },
										from: { type: 'integer' },
										to: { type: 'integer' },
										userPublicKeys: {
											type: 'array',
											items: { type: 'string' },
										},
										market: { type: 'string', nullable: true },
										createdAt: { type: 'integer' },
										completedAt: { type: 'integer', nullable: true },
										recordCount: { type: 'integer', nullable: true },
										errorReason: { type: 'string', nullable: true },
										downloadUrl: { type: 'string', nullable: true },
									},
								},
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			if (!authorityGate(request)) {
				return reply.code(403).send({
					success: false,
					error: 'Signer is not authorised for this authority',
				});
			}

			const nextPage = request.getPaginationToken();
			const { records: jobs, meta } = await repo.listJobsForAuthority(
				request.params.authorityId,
				nextPage
			);

			const records = await Promise.all(
				jobs.map(async (job) => {
					let downloadUrl: string | undefined;
					if (job.status === ExportStatus.Ready && job.s3Key) {
						try {
							downloadUrl = await getSignedUrl(
								s3,
								new GetObjectCommand({ Bucket: bucket, Key: job.s3Key }),
								{ expiresIn: PRESIGN_EXPIRY_SECONDS }
							);
						} catch (err) {
							logger.warn(
								`Failed to presign download URL for ${job.requestId}: ${
									(err as Error).message
								}`
							);
						}
					}
					return {
						requestId: job.requestId,
						status: job.status,
						fileType: job.fileType,
						from: job.from,
						to: job.to,
						userPublicKeys: job.userPublicKeys,
						market: job.market,
						createdAt: job.createdAt,
						completedAt: job.completedAt,
						recordCount: job.recordCount,
						errorReason: job.errorReason,
						downloadUrl,
					};
				})
			);

			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);
};

export default exportRoutes;
