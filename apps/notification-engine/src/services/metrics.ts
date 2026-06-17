import { logger } from '@backend/common';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

enum MetricTypes {
	HealthStatus = 'health_status',
}

export enum HealthStatus {
	Ok = 1,
	NotOk = 0,
}

const METER_NAME = 'notification-engine';
const DEFAULT_METRICS_PORT = PrometheusExporter.DEFAULT_OPTIONS.port;
const { endpoint: DEFAULT_ENDPOINT } = PrometheusExporter.DEFAULT_OPTIONS;

const metricsPort = parseInt(process.env.METRICS_PORT ?? '') || DEFAULT_METRICS_PORT;

const exporter = new PrometheusExporter(
	{
		port: metricsPort,
		endpoint: DEFAULT_ENDPOINT,
	},
	() => {
		logger.info(
			`Prometheus scrape endpoint started: http://localhost:${metricsPort}${DEFAULT_ENDPOINT}`
		);
	}
);

const meterProvider = new MeterProvider({});

meterProvider.addMetricReader(exporter);
metrics.setGlobalMeterProvider(meterProvider);

const meter = metrics.getMeter(METER_NAME);

let healthStatus: HealthStatus = HealthStatus.Ok;

const healthStatusGauge = meter.createObservableGauge(MetricTypes.HealthStatus, {
	description: 'Current health status of the server',
});

healthStatusGauge.addCallback((result) => {
	result.observe(healthStatus);
});

export const updateHealthStatus = (status: HealthStatus): void => {
	healthStatus = status;
};
