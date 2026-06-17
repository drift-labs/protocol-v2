import { isFeatureEnabled } from '@backend/common';
import { FastifyPluginAsync } from 'fastify';

import { validationErrorMessages } from '../../errors/validation-messages';
import builderRoutes from './builder';
import depositRoutes from './deposit';
import executeRoutes from './execute';
import feePayerRoute from './fee';
import orderRoutes from './order';
import settleRoutes from './settle';

const Tx: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.setErrorHandler(validationErrorMessages);

	if (isFeatureEnabled('ONCHAIN_ENDPOINTS', true)) {
		fastify.register(depositRoutes);
		fastify.register(executeRoutes);
		fastify.register(orderRoutes);
		fastify.register(builderRoutes);
		fastify.register(settleRoutes);
	}

	if (isFeatureEnabled('FEE_PAYER', true)) {
		fastify.register(feePayerRoute, { prefix: '/fee' });
	}
};

export default Tx;
