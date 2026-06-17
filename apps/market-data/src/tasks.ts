import { DEFAULT_ENDPOINT, logger } from '@backend/common';
import { getVaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, Keypair } from '@solana/web3.js';
import { DelistedMarketSetting, VelocityClient, VelocityEnv, Wallet } from '@velocity-exchange/sdk';
import { createHealthServer } from './services/health';
import { Scheduler } from './services/scheduler';

import { setupTradePipeline } from './pipelines/trade';
import { setupAnalyticsTasks } from './tasks/analytics';
import { setupClaimTasks } from './tasks/claims';
import { setupLiquidationTasks } from './tasks/liquidations';
import { setupMarketPublishingTask } from './tasks/market';
import { setupPrometheusTasks } from './tasks/prometheus';
import { setupStatsTasks } from './tasks/stats';
import { setupTokenTasks } from './tasks/token';
import { setupVaultTasks } from './tasks/vaults';

const driftEnv = (process.env.ENV ?? 'devnet') as VelocityEnv;
const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, 'confirmed');
const wallet = new Wallet(new Keypair());

const driftClient = new VelocityClient({
	connection,
	wallet,
	env: driftEnv,
	delistedMarketSetting: DelistedMarketSetting.Discard,
});

const vaultClient = getVaultClient(connection, wallet, driftClient as any);

const main = async () => {
	const scheduler = Scheduler();

	createHealthServer(scheduler);

	await driftClient.subscribe();

	try {
		const task = process.env.TASK;
		// Setup tasks
		if (!task || task === 'liquidations') {
			setupLiquidationTasks({ scheduler });
		}
		if (!task || task === 'vaults') {
			setupVaultTasks({ vaultClient, scheduler });
		}
		if (!task || task === 'prometheus') {
			setupPrometheusTasks({ driftClient, scheduler });
		}
		if (!task || task === 'analytics') {
			setupAnalyticsTasks({ driftClient, scheduler });
		}
		if (!task || task === 'claims') {
			setupClaimTasks({ scheduler });
		}
		if (!task || task === 'market') {
			setupMarketPublishingTask({ driftClient, scheduler });
		}
		if (!task || task === 'stats') {
			setupStatsTasks({ driftClient, scheduler });
		}
		if (!task || task === 'tokens') {
			setupTokenTasks({ connection, scheduler });
		}
		// Start pipelines
		if (!task || task === 'trade-pipeline') {
			setupTradePipeline({ scheduler });
		}

		logger.info('Application initialized successfully');
	} catch (error) {
		const { message } = error as Error;
		await logger.error(`Error during initialization: ${message}`);
		throw error;
	}
};

if (process.env.NODE_ENV !== 'test') {
	main().catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`Unhandled error in main: ${message}`);
		process.exit(1);
	});
}
