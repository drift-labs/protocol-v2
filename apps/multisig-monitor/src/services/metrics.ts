/**
 * Prometheus exporter + metric registry for multisig-monitor.
 *
 * Mirrors the pattern in realtime-archiver: a default-port exporter scraped
 * by the cluster's Prometheus, with observable gauges/counters for the
 * signals an oncall would care about:
 *
 *  - health_status            — 1 ok / 0 not ok
 *  - last_event_age_ms        — ms since the last Yellowstone update
 *  - reconnect_attempts       — counter, total reconnects
 *  - reconnect_failures       — counter, reconnects that ultimately failed
 *  - forced_reconnect_attempts — counter, lag-triggered reconnects from-tip
 *  - tx_updates_received      — counter, tx-stream updates dispatched to processor
 *  - account_updates_received — counter, account-stream updates dispatched
 *  - operations_alerted       — counter, multisig ops sent to slack
 *  - signer_events_alerted    — counter, nonce-targeting events sent to slack
 *  - signature_dedup_skips    — counter, sigs dropped by seen-store
 *  - slot_lag                 — gauge, slots behind tip (when known)
 */
import { logger } from '@backend/common';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

enum MetricType {
	HealthStatus = 'health_status',
	LastEventAgeMs = 'last_event_age_ms',
	ReconnectAttempts = 'reconnect_attempts',
	ReconnectFailures = 'reconnect_failures',
	ForcedReconnectAttempts = 'forced_reconnect_attempts',
	TxUpdatesReceived = 'tx_updates_received',
	AccountUpdatesReceived = 'account_updates_received',
	OperationsAlerted = 'operations_alerted',
	SignerEventsAlerted = 'signer_events_alerted',
	SignatureDedupSkips = 'signature_dedup_skips',
	SlotLag = 'slot_lag',
}

export enum HealthStatus {
	Ok = 1,
	NotOk = 0,
}

const METER_NAME = 'multisig-monitor';
const DEFAULT_METRICS_PORT = PrometheusExporter.DEFAULT_OPTIONS.port;
const { endpoint: DEFAULT_ENDPOINT } = PrometheusExporter.DEFAULT_OPTIONS;

const metricsPort = parseInt(process.env.METRICS_PORT ?? '') || DEFAULT_METRICS_PORT;

const exporter = new PrometheusExporter({ port: metricsPort, endpoint: DEFAULT_ENDPOINT }, () => {
	logger.info(
		`Prometheus scrape endpoint started: http://localhost:${metricsPort}${DEFAULT_ENDPOINT}`
	);
});

const meterProvider = new MeterProvider({});
meterProvider.addMetricReader(exporter);
metrics.setGlobalMeterProvider(meterProvider);

const meter = metrics.getMeter(METER_NAME);

let healthStatus: HealthStatus = HealthStatus.Ok;
const healthGauge = meter.createObservableGauge(MetricType.HealthStatus, {
	description: 'Multisig monitor health status (1=ok, 0=not ok)',
});
healthGauge.addCallback((r) => r.observe(healthStatus));
export const updateHealthStatus = (status: HealthStatus): void => {
	healthStatus = status;
};

let lastEventTime = Date.now();
const lastEventAgeGauge = meter.createObservableGauge(MetricType.LastEventAgeMs, {
	description: 'Milliseconds since the last Yellowstone update',
});
lastEventAgeGauge.addCallback((r) => r.observe(Date.now() - lastEventTime));
export const recordEventReceived = (): void => {
	lastEventTime = Date.now();
};
export const getLastEventTime = (): number => lastEventTime;

let slotLag = 0;
const slotLagGauge = meter.createObservableGauge(MetricType.SlotLag, {
	description: 'Slot lag from blockchain tip (when slot-tip lookup is configured)',
});
slotLagGauge.addCallback((r) => r.observe(slotLag));
export const updateSlotLag = (lag: number): void => {
	slotLag = lag;
};

const counter = (name: MetricType, description: string) => {
	let count = 0;
	const c = meter.createObservableCounter(name, { description });
	c.addCallback((r) => r.observe(count));
	return () => {
		count++;
	};
};

export const incrementReconnectAttempts = counter(
	MetricType.ReconnectAttempts,
	'Total reconnect attempts'
);
export const incrementReconnectFailures = counter(
	MetricType.ReconnectFailures,
	'Total reconnect failures'
);
export const incrementForcedReconnectAttempts = counter(
	MetricType.ForcedReconnectAttempts,
	'Total lag-triggered reconnect-from-tip attempts'
);
export const incrementTxUpdatesReceived = counter(
	MetricType.TxUpdatesReceived,
	'Total tx-stream updates received'
);
export const incrementAccountUpdatesReceived = counter(
	MetricType.AccountUpdatesReceived,
	'Total account-stream updates received'
);
export const incrementOperationsAlerted = counter(
	MetricType.OperationsAlerted,
	'Total multisig operations dispatched to slack'
);
export const incrementSignerEventsAlerted = counter(
	MetricType.SignerEventsAlerted,
	'Total signer events dispatched to slack'
);
export const incrementSignatureDedupSkips = counter(
	MetricType.SignatureDedupSkips,
	'Total signatures dropped by the seen-signatures store'
);
