import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import { SDK_MODE } from '../../sdk';

import contractsRoutes from './contracts';
import slackRoutes from './slack';
import tokenRoutes from './token';

const External: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.setErrorHandler(validationErrorMessages);

	// CoinGecko contracts endpoint reads live perp market accounts via the
	// Velocity SDK client — skip in drift mode (frozen, no live RPC).
	if (SDK_MODE === 'velocity') {
		fastify.register(contractsRoutes);
	}
	fastify.register(tokenRoutes);
	fastify.register(slackRoutes);
};

export default External;
