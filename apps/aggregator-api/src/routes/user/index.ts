import { isFeatureEnabled } from '@backend/common';
import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import { futureDateValidation } from '../../hooks/date-validation';
import { SDK_MODE } from '../../sdk';

import depositRoutes from './deposit';
import fundingPaymentRoutes from './funding-payment';
import liquidationRoutes from './liquidation';
import lpRoutes from './lp';
import onChainRoutes from './onchain';
import orderRoutes from './order';
import positionRoutes from './positions';
import predictionRoutes from './prediction';
import rewardRoutes from './reward';
import settlePnlRoutes from './settle-pnl';
import snapshotRoutes from './snapshot';
import swapRoutes from './swap';
import tradeRoutes from './trade';

const Users: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preValidation', futureDateValidation);
	fastify.setErrorHandler(validationErrorMessages);

	fastify.register(depositRoutes, { prefix: '/:accountId/deposits' });
	fastify.register(rewardRoutes, { prefix: '/:accountId/rewards' });
	fastify.register(fundingPaymentRoutes, { prefix: '/:accountId/fundingPayments' });
	fastify.register(liquidationRoutes, { prefix: '/:accountId/liquidations' });
	fastify.register(lpRoutes, { prefix: '/:accountId/lp' });
	fastify.register(orderRoutes, { prefix: '/:accountId/orders' });
	fastify.register(predictionRoutes, { prefix: '/:accountId/predictions' });
	fastify.register(settlePnlRoutes, { prefix: '/:accountId/settlePnl' });
	fastify.register(swapRoutes, { prefix: '/:accountId/swaps' });
	fastify.register(tradeRoutes, { prefix: '/:accountId/trades' });
	fastify.register(positionRoutes, { prefix: '/:accountId/positions' });

	// Snapshots resolve through the cache-proxy; drift mode is frozen so the
	// historical-only API skips them (consumers wanting drift history go
	// through /user/:accountId/trades, /orders, etc).
	if (SDK_MODE === 'velocity' && isFeatureEnabled('SNAPSHOTS_V2', true)) {
		fastify.register(snapshotRoutes, { prefix: '/:accountId/snapshots' });
	}
	// Onchain reads require a live SDK client — skip in drift mode (frozen).
	if (SDK_MODE === 'velocity' && isFeatureEnabled('ONCHAIN_ENDPOINTS', true)) {
		fastify.register(onChainRoutes);
	}
};

export default Users;
