import { DynamoDB } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';

// Public read of the vault config array, hit by the trading UI on a
// per-client polling loop. Source of truth lives in ${ns}-dashboard-db,
// one row per vault at pk='#VAULTS', sk=<pubkey>. CloudFront has a 1-min
// cache on `/vaults` so each viewport contributes ~1 origin hit per
// minute regardless of how many clients are polling. Same store the
// admin write routes touch; response shape mirrors `GET /admin/vaults`.
const VAULT_PK = '#VAULTS';

const stripKeys = (item: Record<string, unknown>): Record<string, unknown> => {
	const { pk: _pk, sk: _sk, ...rest } = item;
	return rest;
};

const vaultsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const dashboardTable = process.env.DASHBOARD_TABLE;
	const { queryAll } = DynamoDB({ overrideTableName: dashboardTable });

	fastify.get(
		'',
		{
			schema: {
				description:
					'Public read of the vault config array. Used by the trading UI; 1-min CloudFront cache.',
				tags: ['Public'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							vaults: {
								type: 'array',
								items: { type: 'object', additionalProperties: true },
							},
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

			const items = await queryAll({ pk: VAULT_PK });
			// Belt-and-braces — the CloudFront behavior already enforces
			// a 1-min TTL, but origin headers help non-CF caches + browser.
			reply.header('Cache-Control', 'public, s-maxage=60, max-age=60');
			return reply.send({ success: true, vaults: items.map(stripKeys) });
		}
	);
};

export default vaultsRoutes;
