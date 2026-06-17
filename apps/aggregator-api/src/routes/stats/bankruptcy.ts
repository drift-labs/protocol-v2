import { LiquidationRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { liquidationSchema, metadataSchema } from '../../schemas';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const bankruptcyRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getLiquidationRecords } = LiquidationRepository();
	const { getBankruptcyStats } = CacheProxyClient();

	fastify.get(
		'',
		{
			schema: {
				description: `<p>
					Retrieve bankruptcy records, with optional pagination. Results are ordered from newest to oldest, with up to 20 unique bankruptcy per request.
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
								properties: {
									totalAmount: { type: 'string' },
									ifPayment: { type: 'string' },
									socialLoss: { type: 'string' },
									totalCount: { type: 'string' },
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
				bankruptcy: true,
				page: nextPage,
			});
			const stats = await getBankruptcyStats();
			return reply.sendPaginatedResponse({ success: true, records, stats, meta });
		}
	);
};

export default bankruptcyRoutes;
