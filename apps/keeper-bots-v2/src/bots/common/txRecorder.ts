import { logger } from '../../logger';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
	MeterProvider,
	View,
	ExplicitBucketHistogramAggregation,
	InstrumentType,
} from '@opentelemetry/sdk-metrics-base';
import { metrics, ObservableGauge, type Histogram } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

export class TxRecorder {
	private txLatency?: Histogram;
	private slotLatency?: Histogram;
	private txLatencyEma?: ObservableGauge;
	private attrs: Record<string, string> = {};
	private movingAvgLatencyMs?: number;
	private emaAlpha: number = 0.1;
	private healthThresholdMs: number = 20000;

	constructor(
		botName: string,
		port?: number,
		disabled?: boolean,
		thresholdMs = 20000
	) {
		// set health threshold regardless of metrics being enabled
		this.healthThresholdMs = thresholdMs;

		if (disabled || !port) {
			logger.info(`metrics disabled for bot ${botName}`);
			return;
		}

		const { endpoint } = PrometheusExporter.DEFAULT_OPTIONS;
		const exporter = new PrometheusExporter({ port, endpoint }, () =>
			logger.info(`prometheus scrape: http://localhost:${port}${endpoint}`)
		);

		const msBuckets = (() => {
			const b: number[] = [];
			for (let i = 0; i <= 1000; i += 50) b.push(i);
			for (let i = 1100; i <= 2000; i += 100) b.push(i);
			for (let i = 2200; i <= 10000; i += 200) b.push(i);
			return b;
		})();
		const slotBuckets = Array.from({ length: 30 }, (_, i) => i + 1);

		const provider = new MeterProvider({
			views: [
				new View({
					instrumentName: 'tx_confirmation_latency',
					instrumentType: InstrumentType.HISTOGRAM,
					aggregation: new ExplicitBucketHistogramAggregation(msBuckets, true),
				}),
				new View({
					instrumentName: 'tx_slot_latency',
					instrumentType: InstrumentType.HISTOGRAM,
					aggregation: new ExplicitBucketHistogramAggregation(
						slotBuckets,
						true
					),
				}),
			],
		});

		provider.addMetricReader(exporter);

		metrics.setGlobalMeterProvider(provider);

		registerInstrumentations({
			meterProvider: provider,
			instrumentations: [getNodeAutoInstrumentations()],
		});

		const meter = metrics.getMeter(botName);

		this.attrs = { bot_name: botName };
		this.txLatency = meter.createHistogram('tx_confirmation_latency', {
			unit: 'ms',
		});
		this.slotLatency = meter.createHistogram('tx_slot_latency', {
			unit: 'slots',
		});
		this.txLatencyEma = meter.createObservableGauge('tx_latency_ema', {
			unit: 'ms',
		});
		this.txLatencyEma.addCallback((result) => {
			result.observe(this.movingAvgLatencyMs ?? 0, this.attrs);
		});
	}

	send(latencyMs: number, slotDelta = 0) {
		this.txLatency?.record(latencyMs, this.attrs);
		this.slotLatency?.record(Math.max(0, slotDelta), this.attrs);

		// update exponential moving average of tx latency
		if (this.movingAvgLatencyMs === undefined) {
			this.movingAvgLatencyMs = latencyMs;
		} else {
			this.movingAvgLatencyMs =
				this.emaAlpha * latencyMs +
				(1 - this.emaAlpha) * this.movingAvgLatencyMs;
		}
	}

	isHealthy(): boolean {
		if (this.movingAvgLatencyMs === undefined) return true;
		return this.movingAvgLatencyMs <= this.healthThresholdMs;
	}
}
