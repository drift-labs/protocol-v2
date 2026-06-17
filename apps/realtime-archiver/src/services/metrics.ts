import { logger } from '@backend/common';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

enum MetricTypes {
	HealthStatus = 'health_status',
	CurrentSlot = 'current_slot',
	SlotDifference = 'slot_difference',
	FailedSlotCount = 'failed_slot_count',
	ReconnectAttempts = 'reconnect_attempts',
	ForcedReconnectAttempts = 'forced_reconnect_attempts',
	ReconnectFailures = 'reconnect_failures',
	DriftTransactions = 'drift_transactions',
	DriftTransactionErrors = 'drift_transaction_errors',
}

export enum HealthStatus {
	Ok = 1,
	NotOk = 0,
}

const METER_NAME = 'realtime-archiver';
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

let currentSlotValue = 0;
const currentSlotGauge = meter.createObservableGauge(MetricTypes.CurrentSlot, {
	description: 'Last ingested slot',
});

currentSlotGauge.addCallback((result) => {
	result.observe(currentSlotValue);
});

export const updateCurrentSlot = (slot: number): void => {
	currentSlotValue = slot;
};

let slotDifference = 0;
const slotDifferenceGauge = meter.createObservableGauge(MetricTypes.SlotDifference, {
	description: 'Slot lag from the tip of the blockchain',
});

slotDifferenceGauge.addCallback((result) => {
	result.observe(slotDifference);
});

export const updateSlotDifference = (slot: number, slotAtTip: number): void => {
	slotDifference = slotAtTip - slot;
};

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

let failedSlotCount = 0;
const failedSlotCountGauge = meter.createObservableGauge(MetricTypes.FailedSlotCount, {
	description: 'Failed slot count',
});
failedSlotCountGauge.addCallback((result) => {
	result.observe(failedSlotCount);
});
export const updateFailedSlotCount = (): void => {
	failedSlotCount++;
};
export const getFailedSlotCount = () => {
	return failedSlotCount;
};

let reconnectAttemptsCount = 0;
const reconnectAttemptsCounter = meter.createObservableCounter(MetricTypes.ReconnectAttempts, {
	description: 'Total number of reconnect attempts',
});

reconnectAttemptsCounter.addCallback((result) => {
	result.observe(reconnectAttemptsCount);
});

export const incrementReconnectAttempts = (): void => {
	reconnectAttemptsCount++;
};

let forcedReconnectAttemptsCount = 0;

const forcedReconnectAttemptsCounter = meter.createObservableCounter(
	MetricTypes.ForcedReconnectAttempts,
	{
		description: 'Total number of forced reconnect attempts',
	}
);

forcedReconnectAttemptsCounter.addCallback((result) => {
	result.observe(forcedReconnectAttemptsCount);
});

export const incrementForcedReconnectAttempts = (): void => {
	forcedReconnectAttemptsCount++;
};

let reconnectFailuresCount = 0;

const reconnectFailuresCounter = meter.createObservableCounter(MetricTypes.ReconnectFailures, {
	description: 'Total number of failed reconnects',
});

export const incrementReconnectFailures = (): void => {
	reconnectFailuresCount++;
};

reconnectFailuresCounter.addCallback((result) => {
	result.observe(reconnectFailuresCount);
});

let driftTransactionsCount = 0;
const driftTransactionsCounter = meter.createObservableCounter(MetricTypes.DriftTransactions, {
	description: 'Total number of Drift/Vault program transactions observed by GRPC ingestion',
});

driftTransactionsCounter.addCallback((result) => {
	result.observe(driftTransactionsCount);
});

export const incrementDriftTransactions = (): void => {
	driftTransactionsCount++;
};

let driftTransactionErrorsCount = 0;
const driftTransactionErrorsCounter = meter.createObservableCounter(
	MetricTypes.DriftTransactionErrors,
	{
		description: 'Total number of Drift/Vault program transactions with errors',
	}
);

driftTransactionErrorsCounter.addCallback((result) => {
	result.observe(driftTransactionErrorsCount);
});

export const incrementDriftTransactionErrors = (): void => {
	driftTransactionErrorsCount++;
};
