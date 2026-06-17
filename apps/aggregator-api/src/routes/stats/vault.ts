import { FastifyPluginAsync } from 'fastify';
import { vaultSchema } from '../../schemas';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const vaultRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getVaultStats } = CacheProxyClient();

	fastify.get(
		'',
		{
			schema: {
				description: ``,
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							vaults: {
								type: 'array',
								items: vaultSchema,
							},
						},
					},
				},
			},
		},
		async function (_, reply) {
			const vaults = await getVaultStats();
			return reply.send({ success: true, vaults });
		}
	);
};

export default vaultRoutes;
