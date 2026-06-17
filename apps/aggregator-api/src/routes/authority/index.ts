import { isFeatureEnabled } from '@backend/common';
import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import { futureDateValidation } from '../../hooks/date-validation';
import { SDK_MODE } from '../../sdk';
import exportRoutes from './exports';
import insuranceFundStake from './insurance-fund-stake';
import lpMintRedeemRoutes from './lp-mint-redeem';
import onChainRoutes from './onchain';
import snapshotRoutes from './snapshot';

const Authority: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preValidation', futureDateValidation);
	fastify.setErrorHandler(validationErrorMessages);

	fastify.register(insuranceFundStake, { prefix: '/:authorityId/insuranceFundStake' });
	fastify.register(lpMintRedeemRoutes, { prefix: '/:authorityId/lpMintRedeem' });

	// Both SDK modes ship the exporter; each Lambda is wired to its own
	// USER_EXPORTS_TABLE / USER_EXPORTS_BUCKET and shares the single SQS
	// queue. Skip if backing resources weren't provisioned for this stage.
	if (process.env.USER_EXPORTS_QUEUE_URL) {
		fastify.register(exportRoutes, { prefix: '/:authorityId/exports' });
	}

	// Snapshots resolve through the cache-proxy; drift mode is frozen so the
	// historical-only API skips them.
	if (SDK_MODE === 'velocity' && isFeatureEnabled('SNAPSHOTS_V2', true)) {
		fastify.register(snapshotRoutes, { prefix: '/:authorityId/snapshots' });
	}

	// Onchain reads require a live SDK client — skip in drift mode (frozen).
	if (SDK_MODE === 'velocity' && isFeatureEnabled('ONCHAIN_ENDPOINTS', true)) {
		fastify.register(onChainRoutes);
	}
};

export default Authority;
