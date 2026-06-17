import { logger } from '@backend/common';
import { GrpcEventSubscriber } from './services/grpc';
import { createHealthServer } from './services/health';

export const main = async () => {
	const { start, stop, getLastEventTime } = GrpcEventSubscriber();

	createHealthServer('grpc', undefined, getLastEventTime);

	start().catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`GRPC has stopped: ${message}`);
		process.exit(1);
	});

	process.on('SIGINT', async () => {
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
