import { DynamoDB } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';

// Public read of the dashboard params blob, hit by the trading UI on a
// per-client polling loop. CloudFront has a 1-min cache on `/params` so
// each viewport contributes ~1 origin hit per minute regardless of how
// many clients are polling. Source of truth is the same DynamoDB row
// the admin endpoints write: `${ns}-dashboard-db` at pk=#PARAMS, sk=#PARAMS.
// Response shape mirrors `GET /admin/params` so clients can target one shape.
const PARAMS_PK = '#PARAMS';
const PARAMS_SK = '#PARAMS';

const paramsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const dashboardTable = process.env.DASHBOARD_TABLE;
	const { get } = DynamoDB({ overrideTableName: dashboardTable });

	fastify.get(
		'',
		{
			schema: {
				description:
					'Public read of the dashboard params blob. Used by the trading UI; 1-min CloudFront cache.',
				tags: ['Public'],
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
			if (!result?.Item?.params) {
				return reply.code(404).send({ success: false, error: 'Params not found' });
			}

			// Belt-and-braces — the CloudFront behavior already enforces a
			// 1-min TTL, but origin headers help any non-CF caches and
			// browser cache too.
			reply.header('Cache-Control', 'public, s-maxage=60, max-age=60');
			return reply.send({
				success: true,
				params: result.Item.params,
				updatedAt: result.Item.updatedAt,
			});
		}
	);
};

export default paramsRoutes;
