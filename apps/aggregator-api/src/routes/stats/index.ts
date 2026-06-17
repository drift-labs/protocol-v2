import { isFeatureEnabled } from '@backend/common';
import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import bankruptcyRoutes from './bankruptcy';
import dlpRoutes from './dlp';
import fundingRateRoutes from './funding-rates';
import insuranceFundRoutes from './insurance-fund';
import insuranceFundSwapRoutes from './insurance-fund-swap';
import leaderboardRoutes from './leaderboard';
import liquidationRoutes from './liquidation';
import marketRoutes from './markets';
import lpAprRoutes from './rates';
import vaultRoutes from './vault';

const Liquidations: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.setErrorHandler(validationErrorMessages);
	fastify.register(liquidationRoutes, { prefix: '/liquidations' });
	fastify.register(bankruptcyRoutes, { prefix: '/bankruptcies' });
	fastify.register(vaultRoutes, { prefix: '/vaults' });
	fastify.register(insuranceFundSwapRoutes, { prefix: '/insuranceFundSwaps' });
	fastify.register(marketRoutes, { prefix: '/markets' });
	fastify.register(fundingRateRoutes, { prefix: '/fundingRates' });
	fastify.register(insuranceFundRoutes, { prefix: '/insuranceFund' });

	fastify.register(dlpRoutes, { prefix: '/dlp' });
	fastify.register(lpAprRoutes, { prefix: '/' });

	if (isFeatureEnabled('LEADERBOARD', true)) {
		fastify.register(leaderboardRoutes, { prefix: '/leaderboard' });
	}
};

export default Liquidations;
