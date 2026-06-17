import { DEFAULT_ENDPOINT, logger } from '@backend/common';
import { RealTimeArchiverRepository } from '@backend/dynamodb';
import { getVaultClient } from '@velocity-exchange/vaults-sdk';
import { Connection, Keypair } from '@solana/web3.js';
import { VelocityClient, VelocityEnv, Wallet } from '@velocity-exchange/sdk';
import { Agent } from 'https';
import { createHealthServer } from './services/health';
import { Ingestion } from './services/ingestion';

const agent = new Agent({
	keepAlive: true,
	maxSockets: 200,
	maxFreeSockets: 100,
	maxTotalSockets: 400,
	timeout: 19000,
	keepAliveMsecs: 19000,
});

const connection = new Connection(process.env.ENDPOINT || DEFAULT_ENDPOINT, {
	commitment: 'finalized',
	httpAgent: agent,
	fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60000) }),
});

const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const wallet = new Wallet(new Keypair());

const driftClient = new VelocityClient({
	env: driftEnv,
	connection,
	wallet,
});

const vaultClient = getVaultClient(connection, wallet, driftClient as any);

export const main = async () => {
	const id = process.env.INGESTION_ID ?? false;
	if (!id) {
		throw new Error('INGESTION_ID is not defined');
	}

	const { getState } = RealTimeArchiverRepository();
	const state = await getState({ id });
	if (!state) {
		throw new Error(`Unable to retrieve state for ${id}`);
	}

	const {
		ingestionIsPaused,
		getSlotAtBlockchainTip,
		incrementSlot,
		processSlotWithBackoff,
		shouldProcessSlot,
		shutdown,
	} = Ingestion({
		state,
		driftClient,
		vaultClient,
		connection,
	});

	createHealthServer('ingestion', state);

	setInterval(async () => {
		try {
			if (ingestionIsPaused()) {
				logger.warn('Ingestion is currently paused', true);
				return;
			}

			await getSlotAtBlockchainTip();

			const { currentSlot, shardId } = state;

			if (shouldProcessSlot(currentSlot)) {
				logger.info(`Processing slot ${currentSlot} for shard ${shardId}`);
				processSlotWithBackoff(currentSlot);
				incrementSlot();
			} else {
				incrementSlot({ incrementBy: 1 });
			}
		} catch (error) {
			const { message } = error as Error;
			await logger.error(message);
			await shutdown();
			throw error;
		}
	}, 300);

	const gracefulShutdown = async () => {
		await shutdown();
		logger.info('Graceful shutdown completed');
		process.exit(0);
	};

	process.on('SIGTERM', () => gracefulShutdown());
	process.on('SIGINT', () => gracefulShutdown());

	process.on('uncaughtException', async (error) => {
		logger.error(`Uncaught exception: ${error.message}`);
		await gracefulShutdown();
	});

	process.on('unhandledRejection', async (reason) => {
		logger.error(`Unhandled rejection: ${reason}`);
		await gracefulShutdown();
	});
};

if (process.env.NODE_ENV !== 'test') {
	main().catch(async (error) => {
		const { message } = error;
		await logger.error(`Unhandled error in main: ${message}`);
	});
}
