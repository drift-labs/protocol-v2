import { FastifyPluginAsync } from 'fastify';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const insuranceFundRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getInsuranceFundStats } = CacheProxyClient();

	fastify.get(
		'',
		{
			schema: {
				description: 'Get insurance fund revenue and market apy data',
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							data: {
								type: 'object',
								properties: {
									totalRevenue: { type: 'string' },
									perpLiqsTotal: { type: 'string' },
									spotLiqsTotal: { type: 'string' },
									marketSharePriceData: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												marketIndex: { type: 'number' },
												symbol: { type: 'string' },
												apy: { type: 'string', nullable: true },
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async function (_, reply) {
			const data = await getInsuranceFundStats();
			return reply.send({
				success: true,
				data,
			});
		}
	);
};

export default insuranceFundRoutes;
