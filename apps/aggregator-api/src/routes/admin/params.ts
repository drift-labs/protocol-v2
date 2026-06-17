import { DynamoDB } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';

const PARAMS_PK = '#PARAMS';
const PARAMS_SK = '#PARAMS';

const paramsBodySchema = {
	type: 'object',
	required: ['params'],
	properties: {
		params: { type: 'object', additionalProperties: true },
	},
	additionalProperties: false,
} as const;

const paramsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const dashboardTable = process.env.DASHBOARD_TABLE;
	const { get, put } = DynamoDB({ overrideTableName: dashboardTable });

	fastify.get(
		'',
		{
			schema: {
				hide: true,
				description: 'Read the dashboard params blob',
				tags: ['Admin'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							params: { type: 'object', additionalProperties: true },
							updatedAt: { type: 'number' },
						},
					},
				},
			},
		},
		async (_request, reply) => {
			if (!dashboardTable) {
				return reply
					.code(503)
					.send({ success: false, error: 'DASHBOARD_TABLE not configured' });
			}

			const result = await get({ pk: PARAMS_PK, sk: PARAMS_SK });
			if (!result?.Item) {
				return reply.code(404).send({ success: false, error: 'Params not found' });
			}

			reply.header('Cache-Control', 'public, s-maxage=60');
			return reply.send({
				success: true,
				params: result.Item.params,
				updatedAt: result.Item.updatedAt,
			});
		}
	);

	fastify.put<{ Body: { params: Record<string, unknown> } }>(
		'',
		{
			schema: {
				hide: true,
				description: 'Write the dashboard params blob',
				tags: ['Admin'],
				body: paramsBodySchema,
				response: {
					200: {
						type: 'object',
						properties: { success: { type: 'boolean' } },
					},
				},
			},
		},
		async (request, reply) => {
			if (!dashboardTable) {
				return reply
					.code(503)
					.send({ success: false, error: 'DASHBOARD_TABLE not configured' });
			}

			await put({
				record: {
					pk: PARAMS_PK,
					sk: PARAMS_SK,
					params: request.body.params,
					updatedAt: Math.floor(Date.now() / 1000),
				},
			});

			return reply.send({ success: true });
		}
	);
};

export default paramsRoutes;
