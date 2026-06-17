import { logger } from '@backend/common';
import { createHealthServer } from './services/health';
import { OracleFeed } from './services/oracle-feed';

const main = async () => {
	createHealthServer();

	const { start, stop, resetLastPrices } = OracleFeed({
		dryRun: !process.env.SNS_TOPIC_ARN,
	});

	start().catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`Price feeds have stopped: ${message}`);
		process.exit(1);
	});

	const restartIntervalMs = Number.parseInt(
		process.env.ORACLE_FEED_RESTART_INTERVAL_MS || '600000',
		10
	);

	let isRestarting = false;
	let restartInterval: NodeJS.Timeout | undefined;

	if (Number.isFinite(restartIntervalMs) && restartIntervalMs > 0) {
		restartInterval = setInterval(async () => {
			if (isRestarting) return;
			isRestarting = true;
			try {
				logger.info('Restarting oracle feed...');
				await stop();
				resetLastPrices();
				await start();
				logger.info('Oracle feed restarted');
				isRestarting = false;
			} catch (error) {
				process.exit(0);
			}
		}, restartIntervalMs);
	}

	process.on('SIGINT', async () => {
		logger.info('Shutting down...');
		if (restartInterval) {
			clearInterval(restartInterval);
		}
		await stop();
		process.exit(0);
	});

	process.on('SIGTERM', async () => {
		logger.info('Shutting down...');
		if (restartInterval) {
			clearInterval(restartInterval);
		}
		await stop();
		process.exit(0);
	});
};

if (process.env.NODE_ENV !== 'test') {
	main().catch(async (error) => {
		const { message } = error;
		await logger.error(`Unhandled error in main: ${message}`);
		throw error;
	});
}
