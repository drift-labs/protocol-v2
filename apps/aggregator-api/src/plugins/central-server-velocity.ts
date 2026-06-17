import { DEFAULT_ENDPOINT, getPerpMarkets, getSpotMarkets } from '@backend/common';
import { Connection } from '@solana/web3.js';
import { CentralServerDrift, HIGH_ACTIVITY_MARKET_ACCOUNTS } from '@velocity-exchange/common';
import { PriorityFeeMethod, VelocityClient, VelocityEnv } from '@velocity-exchange/sdk';
import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

declare module 'fastify' {
	interface FastifyInstance {
		centralServerVelocity: CentralServerDrift;
		velocityClient: VelocityClient;
		connection: Connection;
		ensureVelocityClientSubscribed: () => Promise<void>;
	}
}

const velocityEnv = (process.env.ENV ?? 'mainnet-beta') as VelocityEnv;

const centralServerVelocity = new CentralServerDrift({
	solanaRpcEndpoint: process.env.ENDPOINT || DEFAULT_ENDPOINT,
	velocityEnv: velocityEnv,
	supportedPerpMarkets: getPerpMarkets().map((market) => market.marketIndex),
	supportedSpotMarkets: getSpotMarkets().map((market) => market.marketIndex),
	priorityFeeSubscriberConfig: {
		priorityFeeMethod: PriorityFeeMethod.HELIUS,
		addresses: HIGH_ACTIVITY_MARKET_ACCOUNTS,
	},
});

let subscriptionPromise: Promise<void> | null = null;
let isSubscribing = false;

async function ensureVelocityClientSubscribed(): Promise<void> {
	if (centralServerVelocity.velocityClient._isSubscribed) {
		return;
	}

	if (subscriptionPromise) {
		await subscriptionPromise;
		return;
	}

	if (!isSubscribing) {
		isSubscribing = true;
		subscriptionPromise = centralServerVelocity.subscribe().finally(() => {
			subscriptionPromise = null;
			isSubscribing = false;
		});
	}

	await subscriptionPromise;
}

const centralServerVelocityPlugin: FastifyPluginAsync = async (fastify) => {
	fastify.decorate('centralServerVelocity', centralServerVelocity);
	fastify.decorate('velocityClient', centralServerVelocity.velocityClient);
	fastify.decorate('connection', centralServerVelocity.velocityClient.connection);
	fastify.decorate('ensureVelocityClientSubscribed', ensureVelocityClientSubscribed);

	fastify.addHook('onClose', async () => {
		await centralServerVelocity.unsubscribe();
	});
};

export default fastifyPlugin(centralServerVelocityPlugin);
