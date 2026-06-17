import { DynamoDB } from '@backend/dynamodb';
import { FastifyPluginAsync, FastifyReply } from 'fastify';

// Workflow rows live in ${ns}-dashboard-db (separate from the realtime
// record-db which is for on-chain ingestion). Key shape:
//   pk = '#WORKFLOW#NOTIFICATION'
//   sk = runId
//   GSI1PK = approvalStatus    (pending | approved | rejected)
//   GSI1SK = createdAt (epoch seconds, zero-padded for lexicographic sort)
const WORKFLOW_PK = '#WORKFLOW#NOTIFICATION';

const PADDED_TS_LEN = 12;
const padTs = (n: number) => String(n).padStart(PADDED_TS_LEN, '0');

type ApprovalStatus = 'pending' | 'approved' | 'rejected';

const stripKeys = (item: Record<string, unknown>): Record<string, unknown> => {
	const { pk: _pk, sk: _sk, GSI1PK: _g1pk, GSI1SK: _g1sk, ...rest } = item;
	return rest;
};

const createBodySchema = {
	type: 'object',
	required: ['runId', 'approvalToken', 'notification', 'targeting', 'createdBy'],
	properties: {
		runId: { type: 'string', minLength: 1 },
		approvalToken: { type: 'string', minLength: 1 },
		// `notification` and `targeting` are opaque to the API — the dashboard
		// owns these schemas. Round-tripped as-is.
		notification: { type: 'object', additionalProperties: true },
		targeting: { type: 'object', additionalProperties: true },
		createdBy: { type: 'string', minLength: 1 },
	},
	additionalProperties: false,
} as const;

const patchBodySchema = {
	type: 'object',
	required: ['approvalStatus', 'approvedBy'],
	properties: {
		approvalStatus: { type: 'string', enum: ['approved', 'rejected'] },
		approvedBy: { type: 'string', minLength: 1 },
		scheduleAt: { type: 'integer' },
	},
	additionalProperties: false,
} as const;

const workflowsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const dashboardTable = process.env.DASHBOARD_TABLE;
	const { put, get, query, update } = DynamoDB({ overrideTableName: dashboardTable });

	const guard = (reply: FastifyReply): boolean => {
		if (!dashboardTable) {
			reply.code(503).send({ success: false, error: 'DASHBOARD_TABLE not configured' });
			return false;
		}
		return true;
	};

	fastify.post<{
		Body: {
			runId: string;
			approvalToken: string;
			notification: Record<string, unknown>;
			targeting: Record<string, unknown>;
			createdBy: string;
		};
	}>(
		'',
		{
			schema: {
				hide: true,
				description: 'Create a pending notification-workflow row.',
				tags: ['Admin'],
				body: createBodySchema,
				response: {
					201: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							runId: { type: 'string' },
						},
					},
				},
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const { runId, approvalToken, notification, targeting, createdBy } = request.body;
			const createdAt = Math.floor(Date.now() / 1000);

			try {
				await put({
					record: {
						pk: WORKFLOW_PK,
						sk: runId,
						GSI1PK: 'pending',
						GSI1SK: padTs(createdAt),
						runId,
						approvalToken,
						approvalStatus: 'pending' as ApprovalStatus,
						notification,
						targeting,
						createdBy,
						createdAt,
					},
					conditionExpression: 'attribute_not_exists(pk)',
				});
			} catch (err) {
				if ((err as Error).name === 'ConditionalCheckFailedException') {
					return reply
						.code(409)
						.send({ success: false, error: `Workflow ${runId} already exists` });
				}
				throw err;
			}

			return reply.code(201).send({ success: true, runId });
		}
	);

	fastify.get<{ Querystring: { status?: ApprovalStatus; limit?: number; page?: string } }>(
		'',
		{
			schema: {
				hide: true,
				description:
					'List notification-workflow rows by status (default `pending`), newest first.',
				tags: ['Admin'],
				querystring: {
					type: 'object',
					properties: {
						status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
						limit: { type: 'integer', minimum: 1, maximum: 200 },
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
								items: { type: 'object', additionalProperties: true },
							},
							meta: {
								type: 'object',
								properties: { nextPage: { type: 'string' } },
							},
						},
					},
				},
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const status = request.query.status ?? 'pending';
			const limit = request.query.limit ?? 50;
			const lastEvaluatedKey = request.getPaginationToken();

			const { Items = [], LastEvaluatedKey = null } = await query({
				pk: status,
				secondaryIndex: 'GSI1' as any,
				limit,
				orderAsc: false,
				lastEvaluatedKey,
			});

			return reply.sendPaginatedResponse({
				success: true,
				records: Items.map(stripKeys),
				meta: { nextPage: LastEvaluatedKey },
			});
		}
	);

	fastify.patch<{
		Params: { runId: string };
		Body: {
			approvalStatus: 'approved' | 'rejected';
			approvedBy: string;
			scheduleAt?: number;
		};
	}>(
		'/:runId',
		{
			schema: {
				hide: true,
				description: 'Approve or reject a workflow row. Idempotent; 404 if not found.',
				tags: ['Admin'],
				params: {
					type: 'object',
					required: ['runId'],
					properties: { runId: { type: 'string', minLength: 1 } },
				},
				body: patchBodySchema,
			},
		},
		async (request, reply) => {
			if (!guard(reply)) return;
			const { runId } = request.params;
			const { approvalStatus, approvedBy, scheduleAt } = request.body;

			const existing = await get({ pk: WORKFLOW_PK, sk: runId });
			if (!existing?.Item) {
				return reply.code(404).send({ success: false, error: 'Workflow not found' });
			}

			const approvedAt = Math.floor(Date.now() / 1000);

			await update({
				pk: WORKFLOW_PK,
				sk: runId,
				updateExpression: scheduleAt
					? 'SET approvalStatus = :s, approvedBy = :b, approvedAt = :a, scheduleAt = :sa, GSI1PK = :s'
					: 'SET approvalStatus = :s, approvedBy = :b, approvedAt = :a, GSI1PK = :s',
				expressionValues: {
					':s': approvalStatus,
					':b': approvedBy,
					':a': approvedAt,
					...(scheduleAt ? { ':sa': scheduleAt } : {}),
				},
			});

			return reply.send({ success: true });
		}
	);
};

export default workflowsRoutes;
