import {
	calculateAskPrice,
	calculateBidPrice,
	BN,
	isVariant,
	DriftClient,
	PerpMarketAccount,
	SlotSubscriber,
	PositionDirection,
	OrderType,
	BASE_PRECISION,
	Order,
	PerpPosition,
} from '@drift-labs/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';

import { logger } from '../logger';
import { Bot } from '../types';
import { RuntimeSpec, metricAttrFromUserAccount } from '../metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { Counter, Histogram, Meter, ObservableGauge } from '@opentelemetry/api';
import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	MeterProvider,
	View,
} from '@opentelemetry/sdk-metrics-base';
import { BaseBotConfig } from '../config';

type State = {
	marketPosition: Map<number, PerpPosition>;
	openOrders: Map<number, Array<Order>>;
};

const MARKET_UPDATE_COOLDOWN_SLOTS = 30; // wait slots before updating market position

enum METRIC_TYPES {
	sdk_call_duration_histogram = 'sdk_call_duration_histogram',
	try_make_duration_histogram = 'try_make_duration_histogram',
	runtime_specs = 'runtime_specs',
	mutex_busy = 'mutex_busy',
	errors = 'errors',
}

/**
 *
 * This bot is responsible for placing limit orders that rest on the DLOB.
 * limit price offsets are used to automatically shift the orders with the
 * oracle price, making order updating automatic.
 *
 */
export class FloatingPerpMakerBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 5000;

	private driftClient: DriftClient;
	private slotSubscriber: SlotSubscriber;
	private periodicTaskMutex = new Mutex();
	private lastSlotMarketUpdated: Map<number, number> = new Map();

	private intervalIds: Array<NodeJS.Timer> = [];

	// metrics
	private metricsInitialized = false;
	private metricsPort?: number;
	private exporter?: PrometheusExporter;
	private meter?: Meter;
	private bootTimeMs = Date.now();
	private runtimeSpecsGauge?: ObservableGauge;
	private runtimeSpec?: RuntimeSpec;
	private mutexBusyCounter?: Counter;
	private tryMakeDurationHistogram?: Histogram;

	private agentState?: State;

	/**
	 * Set true to enforce max position size
	 */
	private RESTRICT_POSITION_SIZE = false;

	/**
	 * if a position's notional value passes this percentage of account
	 * collateral, the position enters a CLOSING_* state.
	 */
	private MAX_POSITION_EXPOSURE = 0.1;

	/**
	 * The max amount of quote to spend on each order.
	 */
	private MAX_TRADE_SIZE_QUOTE = 1000;

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	constructor(
		clearingHouse: DriftClient,
		slotSubscriber: SlotSubscriber,
		runtimeSpec: RuntimeSpec,
		config: BaseBotConfig
	) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.driftClient = clearingHouse;
		this.slotSubscriber = slotSubscriber;

		this.metricsPort = config.metricsPort;
		if (this.metricsPort) {
			this.initializeMetrics();
		}
	}

	private initializeMetrics() {
		if (this.metricsInitialized) {
			logger.error('Tried to initilaize metrics multiple times');
			return;
		}
		this.metricsInitialized = true;

		const { endpoint: defaultEndpoint } = PrometheusExporter.DEFAULT_OPTIONS;
		this.exporter = new PrometheusExporter(
			{
				port: this.metricsPort,
				endpoint: defaultEndpoint,
			},
			() => {
				logger.info(
					`prometheus scrape endpoint started: http://localhost:${this.metricsPort}${defaultEndpoint}`
				);
			}
		);
		const meterName = this.name;
		const meterProvider = new MeterProvider({
			views: [
				new View({
					instrumentName: METRIC_TYPES.try_make_duration_histogram,
					instrumentType: InstrumentType.HISTOGRAM,
					meterName: meterName,
					aggregation: new ExplicitBucketHistogramAggregation(
						Array.from(new Array(20), (_, i) => 0 + i * 5),
						true
					),
				}),
			],
		});

		meterProvider.addMetricReader(this.exporter);
		this.meter = meterProvider.getMeter(meterName);

		this.bootTimeMs = Date.now();

		this.runtimeSpecsGauge = this.meter.createObservableGauge(
			METRIC_TYPES.runtime_specs,
			{
				description: 'Runtime sepcification of this program',
			}
		);
		this.runtimeSpecsGauge.addCallback((obs) => {
			obs.observe(this.bootTimeMs, this.runtimeSpec);
		});
		this.mutexBusyCounter = this.meter.createCounter(METRIC_TYPES.mutex_busy, {
			description: 'Count of times the mutex was busy',
		});
		this.tryMakeDurationHistogram = this.meter.createHistogram(
			METRIC_TYPES.try_make_duration_histogram,
			{
				description: 'Distribution of tryTrigger',
				unit: 'ms',
			}
		);
	}

	public async init() {
		logger.info(`${this.name} initing`);
		this.agentState = {
			marketPosition: new Map<number, PerpPosition>(),
			openOrders: new Map<number, Array<Order>>(),
		};
		this.updateAgentState();
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];
	}

	public async startIntervalLoop(intervalMs?: number) {
		await this.updateOpenOrders();
		const intervalId = setInterval(
			this.updateOpenOrders.bind(this),
			intervalMs
		);
		this.intervalIds.push(intervalId);

		logger.info(`${this.name} Bot started!`);
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 2 * this.defaultIntervalMs;
		});
		return healthy;
	}

	/**
	 * Updates the agent state based on its current market positions.
	 *
	 * We want to maintain a two-sided market while being conscious of the positions
	 * taken on by the account.
	 *
	 * As open positions approach MAX_POSITION_EXPOSURE, limit orders are skewed such
	 * that the position that decreases risk will be closer to the oracle price, and the
	 * position that increases risk will be further from the oracle price.
	 *
	 * @returns {Promise<void>}
	 */
	private updateAgentState(): void {
		this.driftClient.getUserAccount()!.perpPositions.map((p) => {
			if (p.baseAssetAmount.isZero()) {
				return;
			}
			this.agentState!.marketPosition.set(p.marketIndex, p);
		});

		// zero out the open orders
		for (const market of this.driftClient.getPerpMarketAccounts()) {
			this.agentState!.openOrders.set(market.marketIndex, []);
		}

		this.driftClient.getUserAccount()!.orders.map((o) => {
			if (isVariant(o.status, 'init')) {
				return;
			}
			const marketIndex = o.marketIndex;
			this.agentState!.openOrders.set(marketIndex, [
				...(this.agentState!.openOrders.get(marketIndex) ?? []),
				o,
			]);
		});
	}

	private async updateOpenOrdersForMarket(marketAccount: PerpMarketAccount) {
		const currSlot = this.slotSubscriber.currentSlot;
		const marketIndex = marketAccount.marketIndex;
		const nextUpdateSlot =
			this.lastSlotMarketUpdated.get(marketIndex) ??
			0 + MARKET_UPDATE_COOLDOWN_SLOTS;

		if (nextUpdateSlot > currSlot) {
			return;
		}

		const openOrders = this.agentState!.openOrders.get(marketIndex) || [];
		const oracle = this.driftClient.getMMOracleDataForPerpMarket(marketIndex);
		const vAsk = calculateAskPrice(marketAccount, oracle);
		const vBid = calculateBidPrice(marketAccount, oracle);

		// cancel orders if not quoting both sides of the market
		let placeNewOrders = openOrders.length === 0;

		if (
			(openOrders.length > 0 && openOrders.length != 2) ||
			marketIndex === 0
		) {
			// cancel orders
			for (const o of openOrders) {
				const tx = await this.driftClient.cancelOrder(o.orderId);
				console.log(
					`${this.name} cancelling order ${this.driftClient
						.getUserAccount()!
						.authority.toBase58()}-${o.orderId}: ${tx}`
				);
			}
			placeNewOrders = true;
		}

		if (placeNewOrders) {
			const biasNum = new BN(90);
			const biasDenom = new BN(100);

			const oracleBidSpread = oracle.price.sub(vBid);
			const tx0 = await this.driftClient.placePerpOrder({
				marketIndex: marketIndex,
				orderType: OrderType.LIMIT,
				direction: PositionDirection.LONG,
				baseAssetAmount: BASE_PRECISION.mul(new BN(1)),
				oraclePriceOffset: oracleBidSpread
					.mul(biasNum)
					.div(biasDenom)
					.neg()
					.toNumber(), // limit bid below oracle
			});
			console.log(`${this.name} placing long: ${tx0}`);

			const oracleAskSpread = vAsk.sub(oracle.price);
			const tx1 = await this.driftClient.placePerpOrder({
				marketIndex: marketIndex,
				orderType: OrderType.LIMIT,
				direction: PositionDirection.SHORT,
				baseAssetAmount: BASE_PRECISION.mul(new BN(1)),
				oraclePriceOffset: oracleAskSpread
					.mul(biasNum)
					.div(biasDenom)
					.toNumber(), // limit ask above oracle
			});
			console.log(`${this.name} placing short: ${tx1}`);
		}

		// enforce cooldown on market
		this.lastSlotMarketUpdated.set(marketIndex, currSlot);
	}

	private async updateOpenOrders() {
		const start = Date.now();
		let ran = false;
		try {
			await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
				this.updateAgentState();
				await Promise.all(
					this.driftClient.getPerpMarketAccounts().map((marketAccount) => {
						console.log(
							`${this.name} updating open orders for market ${marketAccount.marketIndex}`
						);
						this.updateOpenOrdersForMarket(marketAccount);
					})
				);

				ran = true;
			});
		} catch (e) {
			if (e === E_ALREADY_LOCKED) {
				const user = this.driftClient.getUser();
				this.mutexBusyCounter!.add(
					1,
					metricAttrFromUserAccount(
						user.getUserAccountPublicKey(),
						user.getUserAccount()
					)
				);
			} else {
				throw e;
			}
		} finally {
			if (ran) {
				const duration = Date.now() - start;
				const user = this.driftClient.getUser();
				if (this.tryMakeDurationHistogram) {
					this.tryMakeDurationHistogram!.record(
						duration,
						metricAttrFromUserAccount(
							user.getUserAccountPublicKey(),
							user.getUserAccount()
						)
					);
				}
				logger.debug(`${this.name} Bot took ${Date.now() - start}ms to run`);

				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
			}
		}
	}
}
