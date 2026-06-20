import { ObservableResult } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { logger } from '../utils/logger';
import { MeterProvider } from '@opentelemetry/sdk-metrics-base';
import { NextFunction, Request, Response } from 'express';

enum METRIC_TYPES {
	health_status = 'health_status',
	user_pubkey_list_length = 'user_pubkey_list_length',
}

export enum HEALTH_STATUS {
	Ok = 0,
	StaleBulkAccountLoader,
	UnhealthySlotSubscriber,
	LivenessTesting,
}

const metricsPort =
	parseInt(process.env.METRICS_PORT ?? '') ||
	PrometheusExporter.DEFAULT_OPTIONS.port;
const { endpoint: defaultEndpoint } = PrometheusExporter.DEFAULT_OPTIONS;
const exporter = new PrometheusExporter(
	{
		port: metricsPort,
		endpoint: defaultEndpoint,
	},
	() => {
		logger.info(
			`prometheus scrape endpoint started: http://localhost:${metricsPort}${defaultEndpoint}`
		);
	}
);

const meterName = 'usermap-server-meter';
const meterProvider = new MeterProvider();

meterProvider.addMetricReader(exporter);

const meter = meterProvider.getMeter(meterName);

let _currentUserPubkeyListLength = 0;
const getCurrentUserPubkeyListLength = () => _currentUserPubkeyListLength;

const userPubkeyListLengthGauge = meter.createObservableGauge(
	METRIC_TYPES.user_pubkey_list_length,
	{
		description: 'Number of user public keys in the list',
	}
);

userPubkeyListLengthGauge.addCallback((obs: ObservableResult) => {
	obs.observe(getCurrentUserPubkeyListLength());
});

const updateUserPubkeyListLength = (length: number) => {
	_currentUserPubkeyListLength = length;
};

let healthStatus: HEALTH_STATUS = HEALTH_STATUS.Ok;

const healthStatusGauge = meter.createObservableGauge(
	METRIC_TYPES.health_status,
	{
		description: 'Current health status of the server',
	}
);

healthStatusGauge.addCallback((obs: ObservableResult) => {
	obs.observe(healthStatus);
});

const healthCheckInterval = 2000;
let lastHealthCheckSlot = -1;
let lastHealthCheckState = true; // true = healthy, false = unhealthy
let lastHealthCheckPerformed = Date.now() - healthCheckInterval;
let lastTimeHealthy = Date.now() - healthCheckInterval;

const HEALTH_CHECK_GRACE_PERIOD_MS = 10_000; // Grace period is the time since last CONFIRMED healthy, that we will still respond to checks as healthy
const EXPECTED_MIN_PUBLISHER_DELAY_MS = 10_000; // Expect the publisher to be writing something at least once every x ms

/**
 * Middleware that checks if we are in general healthy by checking that the bulk account loader slot
 * has changed recently.
 *
 * We may be hit by multiple sources performing health checks on us, so this middleware will latch
 * to its health state and only update every `healthCheckInterval`.
 *
 * A grace period is also used to only report unhealthy if we have been unhealthy for a certain
 * amount of time. This prevents reporting unhealthy even if we are just in the middle of a
 * bulk account load.
 */
const handleHealthCheck = (core: Core) => {
	return async (_req: Request, res: Response, _next: NextFunction) => {
		const publisher = core.publisher;
		const publisherHealthMetrics = await publisher.getHealthMetrics();

		// healthy if slot has advanced since the last check
		const lastSlotReceived = publisherHealthMetrics.lastReceivedSlot;
		const inGracePeriod =
			Date.now() - lastTimeHealthy <= HEALTH_CHECK_GRACE_PERIOD_MS;

		lastHealthCheckState = lastSlotReceived > lastHealthCheckSlot;

		if (!lastHealthCheckState) {
			logger.error(
				`Unhealthy: lastSlot: ${lastSlotReceived}, lastHealthCheckSlot: ${lastHealthCheckSlot}, timeSinceLastCheck: ${
					Date.now() - lastHealthCheckPerformed
				} ms, sinceLastTimeHealthy: ${
					Date.now() - lastTimeHealthy
				} ms, inGracePeriod: ${inGracePeriod}`
			);
		} else {
			lastTimeHealthy = Date.now();
		}

		lastHealthCheckPerformed = Date.now();

		// Check publisher is subscribed
		if (!publisherHealthMetrics.isSubscribed) {
			healthStatus = HEALTH_STATUS.LivenessTesting;
			logger.error('publisher not subscribed');
			res.writeHead(500);
			res.end(`NOK : publisher not subscribed`);
			return;
		}

		// Check publisher is actively writing to redis
		if (
			Date.now() - publisherHealthMetrics.lastWriteTs >
			EXPECTED_MIN_PUBLISHER_DELAY_MS
		) {
			healthStatus = HEALTH_STATUS.LivenessTesting;
			logger.error('publisher write lag');
			res.writeHead(500);
			res.end(`NOK : publisher write lag`);
			return;
		}

		// Check that the slot is increasing
		if (!lastHealthCheckState) {
			healthStatus = HEALTH_STATUS.LivenessTesting;
			logger.error('publisher rpc slot lag');
			res.writeHead(500);
			res.end(`NOK : publisher rpc slot lag`);
			return;
		}

		lastHealthCheckSlot = lastSlotReceived;

		healthStatus = HEALTH_STATUS.Ok;
		res.writeHead(200);
		res.end('OK');
	};
};

const messageCounter = meter.createCounter('message_counter', {
	description: 'Number of messages received',
});

const errorCounter = meter.createCounter('error_counter', {
	description: 'Number of errors received',
});

export {
	handleHealthCheck,
	updateUserPubkeyListLength,
	messageCounter,
	errorCounter,
};
