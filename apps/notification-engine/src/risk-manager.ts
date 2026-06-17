import { logger } from '@backend/common';
import { createHealthServer } from './services/health';
import { RiskManager } from './services/risk-manager';

const main = async () => {
	createHealthServer();

	const { start, stop, processNotifications } = RiskManager();

	const scheduleNotificationProcessing = async () => {
		await processNotifications();
		setTimeout(scheduleNotificationProcessing, 1000);
	};

	scheduleNotificationProcessing();

	start().catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`Risk manager has stopped: ${message}`);
		await stop();
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
		throw error;
	});
}
