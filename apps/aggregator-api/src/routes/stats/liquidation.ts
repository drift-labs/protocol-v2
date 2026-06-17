import { LiquidationRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { liquidationSchema, metadataSchema } from '../../schemas';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const liquidationRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getLiquidationRecords } = LiquidationRepository();
	const { getLiquidationStats } = CacheProxyClient();

	fastify.get(
		'',
		{
			schema: {
				description: `<p>
					Retrieve liquidations records, with optional pagination. Results are ordered from newest to oldest, with up to 20 unique liquidations per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							stats: {
								'24h': {
									properties: {
										count: { type: 'string' },
										amount: { type: 'string' },
									},
								},
								'30d': {
									properties: {
										count: { type: 'string' },
										amount: { type: 'string' },
									},
								},
							},
							records: {
								type: 'array',
								items: liquidationSchema,
								maxItems: 20,
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getLiquidationRecords({
				page: nextPage,
			});
			const stats = await getLiquidationStats();
			return reply.sendPaginatedResponse({ success: true, records, stats, meta });
		}
	);
};

export default liquidationRoutes;
