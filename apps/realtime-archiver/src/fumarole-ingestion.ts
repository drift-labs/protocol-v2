import { logger } from '@backend/common';
import { FumaroleEventSubscriber } from './services/fumarole';
import { createHealthServer } from './services/health';

export const main = async () => {
	const subscriberName = process.env.APP_STAGE ?? 'local';
	const startFromTip = process.env.START_FROM_TIP === 'true';
	const { start, stop, getLastEventTime } = FumaroleEventSubscriber({
		subscriberName,
		dryRun: subscriberName === 'local', // Enable dry run for local environment
	});

	createHealthServer('fumarole', undefined, getLastEventTime);

	start(startFromTip).catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`Fumarole has stopped: ${message}`);
		process.exit(1);
	});

	process.on('SIGINT', async () => {
		logger.info('Shutting down...');
		await stop();
		process.exit(0);
	});

	process.on('SIGTERM', async () => {
		logger.info('Shutting down...');
		await stop();
		process.exit(0);
	});
};

if (process.env.NODE_ENV !== 'test') {
	main().catch(async (error) => {
		const { message } = error;
		await logger.error(`Unhandled error in main: ${message}`);
	});
}
