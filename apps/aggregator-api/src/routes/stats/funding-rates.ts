import { FastifyPluginAsync } from 'fastify';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const fundingRateRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getFundingRateStats } = CacheProxyClient();

	fastify.get(
		'',
		{
			schema: {
				description:
					'Get average funding rates across multiple time periods for all markets',
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							markets: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										marketIndex: { type: 'number' },
										symbol: { type: 'string' },
										fundingRates: {
											type: 'object',
											properties: {
												'24h': { type: 'string' },
												'7d': { type: 'string' },
												'30d': { type: 'string' },
												'1y': { type: 'string' },
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
			const data = await getFundingRateStats();
			const sortedMarkets = data?.sort((a, b) => a.marketIndex - b.marketIndex);
			return reply.send({
				success: true,
				markets: sortedMarkets,
			});
		}
	);
};

export default fundingRateRoutes;
