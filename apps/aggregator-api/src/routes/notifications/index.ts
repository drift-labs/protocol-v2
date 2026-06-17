import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';

import { solanaAuth } from '../../hooks/solana-auth';
import deviceRoutes from './devices';
import notificationRoutes from './notifications';
import preferencesRoutes from './preferences';

const Notifications: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preHandler', solanaAuth);
	fastify.setErrorHandler(validationErrorMessages);

	fastify.addSchema({
		$id: 'authHeaders',
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
		routeOptions.schema.headers = { $ref: 'authHeaders#' };
	});

	fastify.register(notificationRoutes, { prefix: '' });
	fastify.register(preferencesRoutes, { prefix: '' });
	fastify.register(deviceRoutes, { prefix: '/devices' });
	// fastify.register(alertRoutes, { prefix: '/:authorityId/alerts' });
};

export default Notifications;
