import { logger } from '@backend/common';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

enum MetricTypes {
	HealthStatus = 'health_status',
	WsConnections = 'candle_ws_connections',
	WsSubscriptions = 'candle_ws_subscriptions',
	WsMessages = 'candle_ws_messages_total',
	WsErrors = 'candle_ws_errors_total',
}

export enum HealthStatus {
	Ok = 1,
	NotOk = 0,
}

const METER_NAME = 'candles';
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

let wsConnections = 0;
const wsConnectionsGauge = meter.createObservableGauge(MetricTypes.WsConnections, {
	description: 'Current number of WebSocket connections',
});

wsConnectionsGauge.addCallback((result) => {
	result.observe(wsConnections);
});

export const updateWsConnections = (count: number): void => {
	wsConnections = count;
};

const wsSubscriptionsGauge = meter.createObservableGauge(MetricTypes.WsSubscriptions, {
	description: 'Current number of active subscriptions',
});

let wsSubscriptions = 0;
wsSubscriptionsGauge.addCallback((result) => {
	result.observe(wsSubscriptions);
});

export const updateWsSubscriptions = (count: number): void => {
	wsSubscriptions = count;
};

const wsMessageCounter = meter.createCounter(MetricTypes.WsMessages, {
	description: 'Total number of WebSocket messages processed',
});

export const incrementWsMessages = (): void => {
	wsMessageCounter.add(1);
};

const wsErrorCounter = meter.createCounter(MetricTypes.WsErrors, {
	description: 'Total number of WebSocket errors',
});

export const incrementWsErrors = (): void => {
	wsErrorCounter.add(1);
};
