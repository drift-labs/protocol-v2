import { IngestionState, logger } from '@backend/common';
import { Express } from 'express';
import {
	getFailedSlotCount,
	HealthStatus,
	updateCurrentSlot,
	updateHealthStatus,
	updateSlotDifference,
} from './metrics';

const express = require('express');

const HEALTH_TIMEOUT = 30000;

export function createHealthServer(
	appName: string,
	state?: IngestionState,
	getLastEventTime?: () => number
): Express {
	const app: Express = express();
	const port = process.env.PORT || 3000;

	app.get('/health', (_, res) => {
		if (appName === 'ingestion') {
			if (getFailedSlotCount() > 100) {
				logger.error(`Health status: Restart`);
				res.writeHead(500);
				res.end(`NOK`);
				return;
			}

			updateHealthStatus(HealthStatus.Ok);

			if (state?.currentSlot) {
				updateCurrentSlot(state.currentSlot);

				if (state.slotAtTip) {
					updateSlotDifference(state.currentSlot, state.slotAtTip);
				}
			}

			return res.status(200).json({
				status: 'OK',
				timestamp: new Date().toISOString(),
				state,
			});
		}

		if (appName === 'grpc' || appName === 'fumarole') {
			const lastEventTime = getLastEventTime ? getLastEventTime() : Date.now();
			const timeSinceLastEvent = Date.now() - lastEventTime;
			const isHealthy = timeSinceLastEvent <= HEALTH_TIMEOUT;

			if (!isHealthy) {
				logger.error(
					`${appName} health check failed: No events received for ${timeSinceLastEvent}ms`
				);
				updateHealthStatus(HealthStatus.NotOk);
				res.writeHead(500);
				res.end(`NOK - No events received for ${appName}`);
				return;
			}

			updateHealthStatus(HealthStatus.Ok);
			return res.status(200).json({
				status: 'OK',
				timestamp: new Date().toISOString(),
				timeSinceLastEvent,
			});
		}

		return res.status(200).json({
			status: 'OK',
			timestamp: new Date().toISOString(),
			state,
		});
	});

	app.listen(port, () => {
		logger.info(`Health check server listening on port ${port}`);
	});

	return app;
}
