import { Meter } from '@opentelemetry/api-metrics';
import {
	ExplicitBucketHistogramAggregation,
	MeterProvider,
	View,
} from '@opentelemetry/sdk-metrics-base';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { logger } from './logger';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from '@drift-labs/sdk';
import {
	BatchObservableResult,
	Attributes,
	ObservableGauge,
	Histogram,
	Counter,
} from '@opentelemetry/api';

/**
 * RuntimeSpec is the attributes of the runtime environment, used to
 * distinguish this metric set from others
 */
export type RuntimeSpec = {
	rpcEndpoint: string;
	driftEnv: string;
	commit: string;
	driftPid: string;
	walletAuthority: string;
};

export function metricAttrFromUserAccount(
	userAccountKey: PublicKey,
	ua: UserAccount
): any {
	return {
		subaccount_id: ua.subAccountId,
		public_key: userAccountKey.toBase58(),
		authority: ua.authority.toBase58(),
		delegate: ua.delegate.toBase58(),
	};
}
/**
 * Creates {count} buckets of size {increment} starting from {start}. Each bucket stores the count of values within its "size".
 * @param start
 * @param increment
 * @param count
 * @returns
 */
export function createHistogramBuckets(
	start: number,
	increment: number,
	count: number
) {
	return new ExplicitBucketHistogramAggregation(
		Array.from(new Array(count), (_, i) => start + i * increment)
	);
}

export class GaugeValue {
	private latestGaugeValues: Map<string, number>;
	private gauge: ObservableGauge;

	constructor(gauge: ObservableGauge) {
		this.gauge = gauge;
		this.latestGaugeValues = new Map<string, number>();
	}

	setLatestValue(value: number, attributes: Attributes) {
		const attributesStr = JSON.stringify(attributes);
		this.latestGaugeValues.set(attributesStr, value);
	}

	getLatestValue(attributes: Attributes): number | undefined {
		const attributesStr = JSON.stringify(attributes);
		return this.latestGaugeValues.get(attributesStr);
	}

	getGauge(): ObservableGauge {
		return this.gauge;
	}

	entries(): IterableIterator<[string, number]> {
		return this.latestGaugeValues.entries();
	}
}

export class HistogramValue {
	private histogram: Histogram;
	constructor(histogram: Histogram) {
		this.histogram = histogram;
	}

	record(value: number, attributes: Attributes) {
		this.histogram.record(value, attributes);
	}
}

export class CounterValue {
	private counter: Counter;
	constructor(counter: Counter) {
		this.counter = counter;
	}

	add(value: number, attributes: Attributes) {
		this.counter.add(value, attributes);
	}
}

export class Metrics {
	private exporter: PrometheusExporter;
	private meterProvider: MeterProvider;
	private meters: Map<string, Meter>;
	private gauges: Array<GaugeValue>;
	private defaultMeterName: string;

	constructor(meterName: string, views?: Array<View>, metricsPort?: number) {
		const { endpoint: defaultEndpoint, port: defaultPort } =
			PrometheusExporter.DEFAULT_OPTIONS;
		const port = metricsPort || defaultPort;
		this.exporter = new PrometheusExporter(
			{
				port: port,
				endpoint: defaultEndpoint,
			},
			() => {
				logger.info(
					`prometheus scrape endpoint started: http://localhost:${port}${defaultEndpoint}`
				);
			}
		);

		this.meterProvider = new MeterProvider({ views });
		this.meterProvider.addMetricReader(this.exporter);
		this.gauges = new Array<GaugeValue>();
		this.meters = new Map<string, Meter>();
		this.defaultMeterName = meterName;
		this.getMeter(this.defaultMeterName);
	}

	getMeter(name: string): Meter {
		if (this.meters.has(name)) {
			return this.meters.get(name) as Meter;
		} else {
			const meter = this.meterProvider.getMeter(name);
			this.meters.set(name, meter);
			return meter;
		}
	}

	addGauge(
		metricName: string,
		description: string,
		meterName?: string
	): GaugeValue {
		const meter = this.getMeter(meterName ?? this.defaultMeterName);
		const newGauge = meter.createObservableGauge(metricName, {
			description: description,
		});
		const gauge = new GaugeValue(newGauge);
		this.gauges.push(gauge);
		return gauge;
	}

	addHistogram(
		metricName: string,
		description: string,
		meterName?: string
	): HistogramValue {
		const meter = this.getMeter(meterName ?? this.defaultMeterName);
		return new HistogramValue(
			meter.createHistogram(metricName, {
				description: description,
			})
		);
	}

	addCounter(
		metricName: string,
		description: string,
		meterName?: string
	): CounterValue {
		const meter = this.getMeter(meterName ?? this.defaultMeterName);
		return new CounterValue(
			meter.createCounter(metricName, {
				description: description,
			})
		);
	}

	/**
	 * Finalizes the observables by adding the batch observable callback to each meter.
	 * Must call this before using this Metrics object
	 */
	finalizeObservables() {
		for (const meter of this.meters.values()) {
			meter.addBatchObservableCallback(
				(observerResult: BatchObservableResult) => {
					for (const gauge of this.gauges) {
						for (const [attributesStr, value] of gauge.entries()) {
							const attributes = JSON.parse(attributesStr);
							observerResult.observe(gauge.getGauge(), value, attributes);
						}
					}
				},
				this.gauges.map((gauge) => gauge.getGauge())
			);
		}
	}
}
