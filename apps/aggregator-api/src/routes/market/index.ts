import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import { futureDateValidation } from '../../hooks/date-validation';
import { SDK_MODE } from '../../sdk';

import candleRoutes from './candles';
import depositRoutes from './deposit';
import fundingRateRoutes from './funding-rates';
import insuranceFundRoutes from './insurance-fund';
import insuranceFundStakeRoutes from './insurance-fund-stake';
import predictionRoutes from './predictions';
import rewardRoutes from './reward';
import swapRoutes from './swap';
import tradeRoutes from './trades';

const Market: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preValidation', futureDateValidation);
	fastify.setErrorHandler(validationErrorMessages);

	fastify.register(tradeRoutes, { prefix: '/:symbol/trades' });
	fastify.register(predictionRoutes, { prefix: '/:symbol/predictions' });
	// Candle reads come from Redis via the cache-proxy and imply a live feed;
	// drift mode is frozen so there's nothing new to read.
	if (SDK_MODE === 'velocity') {
		fastify.register(candleRoutes, { prefix: '/:symbol/candles' });
	}
	fastify.register(fundingRateRoutes, { prefix: '/:symbol/fundingRates' });
	fastify.register(insuranceFundRoutes, { prefix: '/:symbol/insuranceFund' });
	fastify.register(swapRoutes, { prefix: '/:symbol/swaps' });
	fastify.register(depositRoutes, { prefix: '/:symbol/deposits' });
	fastify.register(rewardRoutes, { prefix: '/:symbol/rewards' });
	fastify.register(insuranceFundStakeRoutes, { prefix: '/:symbol/insuranceFundStake' });
};

export default Market;
