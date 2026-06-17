import { logger } from '@backend/common';
import { DLQProcessor } from '../services/dlq-processor';

async function main() {
	const { start, stop } = DLQProcessor({ isRunning: true });

	process.on('SIGINT', () => {
		logger.info('Received SIGINT. Gracefully shutting down...');
		stop();
	});

	process.on('SIGTERM', () => {
		logger.info('Received SIGTERM. Gracefully shutting down...');
		stop();
	});

	await start();
}

if (process.env.NODE_ENV !== 'test') {
	main().catch((error) => {
		logger.error(`Unhandled error in main: ${error.message}`);
		process.exit(1);
	});
}
