import { logger } from '@backend/common';
import { loadConfig } from './config';
import { setLogLevel } from './log';
import { createHealthServer } from './services/health';
import { MultisigFumaroleSubscriber } from './services/fumarole';
import { createStateStore } from './services/state';

export const main = async () => {
	const config = loadConfig();
	setLogLevel(config.logLevel);

	logger.info(
		`multisig-monitor starting: ${config.multisigAddresses.length} multisig(s), ${config.signerAddresses.length} council signer(s), state table=${config.state.tableName}`
	);

	const store = createStateStore(config.state);
	const subscriber = MultisigFumaroleSubscriber(config, store);
	createHealthServer(config.healthPort, subscriber.getLastEventTime);

	subscriber.start(config.fumarole.startFromTip).catch(async (err) => {
		const { message } = (err as Error) ?? { message: String(err) };
		await logger.error(`Fumarole subscriber stopped: ${message}`);
		process.exit(1);
	});

	const shutdown = async (signal: string) => {
		logger.info(`Received ${signal}, shutting down...`);
		await subscriber.stop();
		process.exit(0);
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

if (process.env.NODE_ENV !== 'test') {
	main().catch(async (err) => {
		const { message } = (err as Error) ?? { message: String(err) };
		await logger.error(`Unhandled error in main: ${message}`);
		process.exit(1);
	});
}
