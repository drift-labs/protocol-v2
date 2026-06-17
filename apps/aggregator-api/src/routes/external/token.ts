import { FastifyPluginAsync } from 'fastify';
import { CacheProxyClient } from '../../utils/cache-proxy-client';
const DRIFT_TOKEN_TOTAL_SUPPLY = 1e9;

type TokenQueryParamsSchema = {
	Params: {
		type: 'circulating-supply' | 'total-supply' | 'locked-supply';
	};
};

const tokenQueryParamsSchema = {
	type: 'object',
	properties: {
		type: {
			type: 'string',
			enum: ['circulating-supply', 'total-supply', 'locked-supply'],
		},
	},
	required: ['type'],
};

const tokenRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getTokenStats } = CacheProxyClient();

	fastify.get<TokenQueryParamsSchema>(
		'/token/coingecko/:type',
		{
			schema: {
				description: `Retrieve circulating, locked and total supply for the DRIFT token.`,
				tags: ['External'],
				params: tokenQueryParamsSchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							result: { type: 'string' },
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { type } = request.params;
			if (type === 'total-supply')
				return reply.send({ success: true, result: DRIFT_TOKEN_TOTAL_SUPPLY.toString() });

			try {
				const circulatingSupply = (await getTokenStats()) || 0;

				if (type === 'circulating-supply')
					return reply.send({ success: true, result: circulatingSupply.toString() });

				if (type === 'locked-supply') {
					const lockedSupply = DRIFT_TOKEN_TOTAL_SUPPLY - circulatingSupply;
					return reply.send({ success: true, result: lockedSupply.toString() });
				}
			} catch (error) {
				return reply
					.code(500)
					.send({ success: false, error: 'Failed to retrieve token stats' });
			}
		}
	);

	fastify.get<TokenQueryParamsSchema>(
		'/token/cmc/:type',
		{
			schema: {
				description: `Retrieve circulating, locked and total supply for the DRIFT token.`,
				tags: ['External'],
				params: tokenQueryParamsSchema,
				response: {
					200: {
						type: 'string',
					},
				},
			},
		},
		async function (request, reply) {
			const { type } = request.params;
			if (type === 'total-supply') return reply.send(DRIFT_TOKEN_TOTAL_SUPPLY.toString());

			try {
				const circulatingSupply = (await getTokenStats()) || 0;
				if (type === 'circulating-supply') return reply.send(circulatingSupply.toString());

				if (type === 'locked-supply') {
					const lockedSupply = DRIFT_TOKEN_TOTAL_SUPPLY - circulatingSupply;
					return reply.send(lockedSupply.toString());
				}
			} catch (error) {
				return reply.code(500).send('Failed to retrieve token stats');
			}
		}
	);
};

export default tokenRoutes;
