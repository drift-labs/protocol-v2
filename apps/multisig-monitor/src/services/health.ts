import { logger } from '@backend/common';
import express from 'express';
import { HealthStatus, updateHealthStatus } from './metrics';

const HEALTH_TIMEOUT = 30_000;

export function createHealthServer(port: number, getLastEventTime: () => number): void {
	const app = express();

	app.get('/health', (_, res) => {
		const lastEventTime = getLastEventTime();
		const timeSinceLastEvent = Date.now() - lastEventTime;
		const isHealthy = timeSinceLastEvent <= HEALTH_TIMEOUT;

		if (!isHealthy) {
			logger.error(
				`multisig-monitor health check failed: no events received for ${timeSinceLastEvent}ms`
			);
			updateHealthStatus(HealthStatus.NotOk);
			res.writeHead(500);
			res.end('NOK');
			return;
		}

		updateHealthStatus(HealthStatus.Ok);
		res.status(200).json({
			status: 'OK',
			timestamp: new Date().toISOString(),
			timeSinceLastEvent,
		});
	});

	app.listen(port, () => {
		logger.info(`Health check server listening on port ${port}`);
	});
}
