import { Request, Response } from 'express';
import responseTime = require('response-time');
import { MEASURED_ENDPOINTS } from '../utils/constants';
import { SlotSource } from '@velocity-exchange/sdk';
import {
	evaluateHealth,
	globalHealthState,
	setHealthStatus,
	HEALTH_STATUS,
} from './healthCheck';
import { logger } from '../utils/logger';
import { GaugeValue } from './metricsV2';

export const handleResponseTime = (
	measuredEndpoints: string[] = MEASURED_ENDPOINTS
) => {
	return responseTime((req: Request, _res: Response, _time: number) => {
		const endpoint = req.path;

		if (!measuredEndpoints.includes(endpoint)) {
			return;
		}
		//if (endpoint === '/health' || req.url === '/') {
		//  return;
		//}

		// TODO: add these back if want to profile response times

		// responseStatusCounter.add(1, {
		// 	endpoint,
		// 	status: res.statusCode,
		// });

		// const responseTimeMs = time;
		// endpointResponseTimeHistogram.record(responseTimeMs, {
		// 	endpoint,
		// });
	});
};

/**
 * Middleware that checks the health of the slot subscriber.
 * Health is determined by:
 * 1. Regular slot updates
 * 2. Minimum slot update rate
 */
export const handleHealthCheck = (
	slotSource: SlotSource,
	healthCheckGauge?: GaugeValue
) => {
	return async (_req, res, _next) => {
		const currentSlot = slotSource.getSlot();
		const { isHealthy, reason } = evaluateHealth(currentSlot);

		if (!isHealthy) {
			logger.error(
				`Unhealthy: ${reason}, ` +
					`Details: currentSlot=${currentSlot}, ` +
					`lastSlot=${globalHealthState.lastSlot}, ` +
					`timeSinceLastSlot=${
						Date.now() - globalHealthState.lastSlotTimestamp
					}ms`
			);
			if (healthCheckGauge) {
				healthCheckGauge.setLatestValue(
					Number(HEALTH_STATUS.UnhealthySlotSubscriber),
					{}
				);
			}
			setHealthStatus(HEALTH_STATUS.UnhealthySlotSubscriber);
			res.writeHead(500);
			res.end('NOK');
			return;
		}

		if (healthCheckGauge) {
			healthCheckGauge.setLatestValue(Number(HEALTH_STATUS.Ok), {});
		}
		setHealthStatus(HEALTH_STATUS.Ok);
		res.writeHead(200);
		res.end('OK');
	};
};
