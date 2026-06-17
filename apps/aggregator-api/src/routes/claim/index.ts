import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import { solanaAuth } from '../../hooks/solana-auth';
import claimRoutes from './claim';

const Claim: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preHandler', solanaAuth);
	fastify.setErrorHandler(validationErrorMessages);

	fastify.addSchema({
		$id: 'claimAuthHeaders',
		type: 'object',
		required: ['x-wallet-address', 'x-signature', 'x-signed-message'],
		properties: {
			'x-wallet-address': {
				type: 'string',
				description: 'Solana wallet address',
			},
			'x-signature': {
				type: 'string',
				description: 'Signed message signature',
			},
			'x-signed-message': {
				type: 'string',
				description:
					'JSON string containing timestamp and action. Format: {"action": "string", "ts": "Unix timestamp (seconds)", "walletAddress": "string", "isDelegate"?: boolean, "driftUserAccount"?: "string"}',
			},
		},
	});

	fastify.addHook('onRoute', (routeOptions) => {
		if (!routeOptions.schema) routeOptions.schema = {};
		routeOptions.schema.headers = { $ref: 'claimAuthHeaders#' };
	});

	fastify.register(claimRoutes, { prefix: '' });
};

export default Claim;
