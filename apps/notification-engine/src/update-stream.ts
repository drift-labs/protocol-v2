import { logger } from '@backend/common';
import { createHealthServer } from './services/health';
import { UpdateManager } from './services/update-manager';

const main = async () => {
	createHealthServer();

	const { start, stop, processUserUpdates } = UpdateManager();

	const scheduleUserUpdateProcessing = async () => {
		await processUserUpdates();
		setTimeout(scheduleUserUpdateProcessing, 300);
	};

	scheduleUserUpdateProcessing();

	start().catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`Uncaught error: ${message}`);
		await stop();
		process.exit(1);
	});

	process.on('SIGINT', async () => {
		await stop();
		process.exit(0);
	});

	process.on('SIGTERM', async () => {
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
