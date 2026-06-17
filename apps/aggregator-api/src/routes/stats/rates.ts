import { RateHistoryType } from '@backend/common';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const lpAprRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getRateHistory } = CacheProxyClient();

	fastify.get<{
		Params: {
			symbol: string;
			type: RateHistoryType;
		};
	}>(
		':symbol/rateHistory/:type',
		{
			preValidation: marketValidation({ type: 'spot' }),
			schema: {
				description: ``,
				tags: ['Stats'],
				params: {
					type: 'object',
					properties: {
						symbol: { type: 'string' },
						type: {
							type: 'string',
							default: 'deposit',
							enum: Object.values(RateHistoryType),
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							rates: {
								type: 'array',
								items: {
									type: 'array',
									items: {
										oneOf: [
											{
												type: 'integer',
											},
											{
												type: 'string',
											},
										],
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { symbol, type } = request.params;
			const rates = await getRateHistory({ symbol, type });
			return reply.send({ success: true, rates });
		}
	);
};

export default lpAprRoutes;
