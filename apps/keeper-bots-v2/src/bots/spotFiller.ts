import {
	DriftClient,
	SpotMarketAccount,
	MakerInfo,
	isVariant,
	DLOB,
	NodeToFill,
	UserMap,
	UserStatsMap,
	MarketType,
	DLOBNode,
	DLOBSubscriber,
	PhoenixSubscriber,
	BN,
	PhoenixV1FulfillmentConfigAccount,
	TEN,
	NodeToTrigger,
	OrderSubscriber,
	UserAccount,
	PriorityFeeSubscriber,
	DataAndSlot,
	BlockhashSubscriber,
	JupiterClient,
	ClockSubscriber,
	OpenbookV2FulfillmentConfigAccount,
	OpenbookV2Subscriber,
} from '@drift-labs/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';

import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	Connection,
	LAMPORTS_PER_SOL,
	PublicKey,
	SendTransactionError,
	TransactionInstruction,
	TransactionSignature,
	VersionedTransaction,
	VersionedTransactionResponse,
} from '@solana/web3.js';

import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	View,
} from '@opentelemetry/sdk-metrics-base';

import { logger } from '../logger';
import { Bot } from '../types';
import {
	CounterValue,
	GaugeValue,
	HistogramValue,
	Metrics,
	RuntimeSpec,
	metricAttrFromUserAccount,
} from '../metrics';
import { webhookMessage } from '../webhook';
import { getErrorCode } from '../error';
import {
	isEndIxLog,
	isFillIxLog,
	isIxLog,
	isMakerBreachedMaintenanceMarginLog,
	isOrderDoesNotExistLog,
	isTakerBreachedMaintenanceMarginLog,
} from './common/txLogParse';
import { FillerConfig, GlobalConfig } from '../config';
import {
	getFillSignatureFromUserAccountAndOrderId,
	getNodeToFillSignature,
	getNodeToTriggerSignature,
	getTransactionAccountMetas,
	handleSimResultError,
	initializeSpotFulfillmentAccounts,
	logMessageForNodeToFill,
	simulateAndGetTxWithCUs,
	SimulateAndGetTxWithCUsResponse,
	sleepMs,
	swapFillerHardEarnedUSDCForSOL,
	validMinimumGasAmount,
	validRebalanceSettledPnlThreshold,
} from '../utils';
import { JITO_METRIC_TYPES, BundleSender } from '../bundleSender';
import {
	CACHED_BLOCKHASH_OFFSET,
	CONFIRM_TX_INTERVAL_MS,
	CONFIRM_TX_RATE_LIMIT_BACKOFF_MS,
	MakerNodeMap,
	TX_CONFIRMATION_BATCH_SIZE,
	TX_TIMEOUT_THRESHOLD_MS,
	TxType,
} from './filler';
import { selectMakers } from '../makerSelection';
import { LRUCache } from 'lru-cache';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import { FallbackLiquiditySource } from '../experimental-bots/filler-common/types';

const THROTTLED_NODE_SIZE_TO_PRUNE = 10; // Size of throttled nodes to get to before pruning the map
const FILL_ORDER_THROTTLE_BACKOFF = 1000; // the time to wait before trying to fill a throttled (error filling) node again
const TRIGGER_ORDER_COOLDOWN_MS = 1000; // the time to wait before trying to a node in the triggering map again
const SIM_CU_ESTIMATE_MULTIPLIER = 1.15;
const SLOTS_UNTIL_JITO_LEADER_TO_SEND = 4;
const CONFIRM_TX_ATTEMPTS = 2;
const MAX_MAKERS_PER_FILL = 6; // max number of unique makers to include per fill
const MAX_ACCOUNTS_PER_TX = 64; // solana limit, track https://github.com/solana-labs/solana/issues/27241

const DUMP_TXS_IN_SIM = false;

const EXPIRE_ORDER_BUFFER_SEC = 60; // add extra time before trying to expire orders (want to avoid 6252 error due to clock drift)

const errorCodesToSuppress = [
	6061, // 0x17AD Error Number: 6061. Error Message: Order does not exist.
	// 6078, // 0x17BE Error Number: 6078. Error Message: PerpMarketNotFound
	6239, // 0x185F Error Number: 6239. Error Message: RevertFill.
	6023, // 0x1787 Error Number: 6023. Error Message: PriceBandsBreached.

	6111, // Error Message: OrderNotTriggerable.
	6112, // Error Message: OrderDidNotSatisfyTriggerCondition.

	6252, // Error Message: ImpossibleFill, expired order not ready.
];

enum METRIC_TYPES {
	try_fill_duration_histogram = 'try_fill_duration_histogram',
	runtime_specs = 'runtime_specs',
	last_try_fill_time = 'last_try_fill_time',
	mutex_busy = 'mutex_busy',
	sent_transactions = 'sent_transactions',
	landed_transactions = 'landed_transactions',
	tx_sim_error_count = 'tx_sim_error_count',
	pending_tx_sigs_to_confirm = 'pending_tx_sigs_to_confirm',
	pending_tx_sigs_loop_rate_limited = 'pending_tx_sigs_loop_rate_limited',
	evicted_pending_tx_sigs_to_confirm = 'evicted_pending_tx_sigs_to_confirm',
	estimated_tx_cu_histogram = 'estimated_tx_cu_histogram',
	simulate_tx_duration_histogram = 'simulate_tx_duration_histogram',
	expired_nodes_set_size = 'expired_nodes_set_size',

	clock_subscriber_ts = 'clock_subscriber_ts',
	wall_clock_ts = 'wall_clock_ts',
}

function getMakerNodeFromNodeToFill(
	nodeToFill: NodeToFill
): DLOBNode | undefined {
	if (nodeToFill.makerNodes.length === 0) {
		return undefined;
	}

	if (nodeToFill.makerNodes.length > 1) {
		logger.error(
			`Found more than one maker node for spot nodeToFill: ${JSON.stringify(
				nodeToFill
			)}`
		);
		return undefined;
	}

	return nodeToFill.makerNodes[0];
}

export type NodesToFillWithContext = {
	nodesToFill: NodeToFill[];
	fallbackAskSource?: FallbackLiquiditySource;
	fallbackBidSource?: FallbackLiquiditySource;
};

export type DLOBProvider = {
	subscribe(): Promise<void>;
	getDLOB(slot: number): Promise<DLOB>;
	getUniqueAuthorities(): PublicKey[];
	getUserAccounts(): Generator<{
		userAccount: UserAccount;
		publicKey: PublicKey;
	}>;
	getUserAccount(publicKey: PublicKey): UserAccount | undefined;
	size(): number;
	fetch(): Promise<void>;
};

export function getDLOBProviderFromOrderSubscriber(
	orderSubscriber: OrderSubscriber
): DLOBProvider {
	return {
		subscribe: async () => {
			await orderSubscriber.subscribe();
		},
		getDLOB: async (slot: number) => {
			return await orderSubscriber.getDLOB(slot);
		},
		getUniqueAuthorities: () => {
			const authorities = new Set<string>();
			for (const { userAccount } of orderSubscriber.usersAccounts.values()) {
				authorities.add(userAccount.authority.toBase58());
			}
			const pubkeys = Array.from(authorities).map((a) => new PublicKey(a));
			return pubkeys;
		},
		getUserAccounts: function* () {
			for (const [
				key,
				{ userAccount },
			] of orderSubscriber.usersAccounts.entries()) {
				yield { userAccount: userAccount, publicKey: new PublicKey(key) };
			}
		},
		getUserAccount: (publicKey) => {
			return orderSubscriber.usersAccounts.get(publicKey.toString())
				?.userAccount;
		},
		size(): number {
			return orderSubscriber.usersAccounts.size;
		},
		fetch() {
			return orderSubscriber.fetch();
		},
	};
}

export class SpotFillerBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 2000;

	private driftClient: DriftClient;
	private clockSubscriber: ClockSubscriber;
	/// Connection to use specifically for confirming transactions
	private txConfirmationConnection: Connection;
	private globalConfig: GlobalConfig;
	private fillerConfig: FillerConfig;
	private blockhashSubscriber: BlockhashSubscriber;
	private pollingIntervalMs: number;
	private fillTxId = 0;

	private dlobSubscriber?: DLOBSubscriber;

	private userMap: UserMap;
	private orderSubscriber: OrderSubscriber;
	private userStatsMap?: UserStatsMap;

	private phoenixFulfillmentConfigMap: Map<
		number,
		PhoenixV1FulfillmentConfigAccount
	>;
	private phoenixSubscribers?: Map<number, PhoenixSubscriber>;

	private openbookFulfillmentConfigMap: Map<
		number,
		OpenbookV2FulfillmentConfigAccount
	>;
	private openbookSubscribers?: Map<number, OpenbookV2Subscriber>;

	private periodicTaskMutex = new Mutex();

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	private intervalIds: Array<NodeJS.Timer> = [];
	private throttledNodes = new Map<string, number>();
	private triggeringNodes = new Map<string, number>();

	private priorityFeeSubscriber: PriorityFeeSubscriber;
	private revertOnFailure: boolean;
	private simulateTxForCUEstimate?: boolean;
	private bundleSender?: BundleSender;

	/// stores txSigs that need to been confirmed in a slower loop, and the time they were confirmed
	protected pendingTxSigsToconfirm: LRUCache<
		string,
		{
			ts: number;
			nodeFilled?: NodeToFill;
			fillTxId: number;
			txType: TxType;
		}
	>;
	protected expiredNodesSet: LRUCache<string, boolean>;
	protected confirmLoopRunning = false;
	protected confirmLoopRateLimitTs =
		Date.now() - CONFIRM_TX_RATE_LIMIT_BACKOFF_MS;

	// metrics
	private metricsInitialized = false;
	private metricsPort?: number;
	protected metrics?: Metrics;
	private bootTimeMs?: number;

	protected runtimeSpec: RuntimeSpec;
	protected runtimeSpecsGauge?: GaugeValue;
	protected tryFillDurationHistogram?: HistogramValue;
	protected estTxCuHistogram?: HistogramValue;
	protected simulateTxHistogram?: HistogramValue;
	protected lastTryFillTimeGauge?: GaugeValue;
	protected mutexBusyCounter?: CounterValue;
	protected sentTxsCounter?: CounterValue;
	protected attemptedTriggersCounter?: CounterValue;
	protected landedTxsCounter?: CounterValue;
	protected txSimErrorCounter?: CounterValue;
	protected pendingTxSigsToConfirmGauge?: GaugeValue;
	protected pendingTxSigsLoopRateLimitedCounter?: CounterValue;
	protected evictedPendingTxSigsToConfirmCounter?: CounterValue;
	protected expiredNodesSetSize?: GaugeValue;
	protected jitoConnectedGauge?: GaugeValue;
	protected jitoBundlesAcceptedGauge?: GaugeValue;
	protected jitoBundlesSimulationFailureGauge?: GaugeValue;
	protected jitoDroppedBundleGauge?: GaugeValue;
	protected jitoLandedTipsGauge?: GaugeValue;
	protected jitoBundleCount?: GaugeValue;
	protected clockSubscriberTs?: GaugeValue;
	protected wallClockTs?: GaugeValue;

	protected rebalanceFiller?: boolean;
	protected jupiterClient?: JupiterClient;

	protected hasEnoughSolToFill: boolean = false;
	protected minGasBalanceToFill: number;
	protected rebalanceSettledPnlThreshold: BN;

	protected lookupTableAccounts: AddressLookupTableAccount[];

	constructor(
		driftClient: DriftClient,
		userMap: UserMap,
		runtimeSpec: RuntimeSpec,
		globalConfig: GlobalConfig,
		config: FillerConfig,
		priorityFeeSubscriber: PriorityFeeSubscriber,
		blockhashSubscriber: BlockhashSubscriber,
		bundleSender?: BundleSender,
		lookupTableAccounts: AddressLookupTableAccount[] = []
	) {
		this.globalConfig = globalConfig;
		this.fillerConfig = config;
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.driftClient = driftClient;
		if (globalConfig.txConfirmationEndpoint) {
			this.txConfirmationConnection = new Connection(
				globalConfig.txConfirmationEndpoint
			);
		} else {
			this.txConfirmationConnection = this.driftClient.connection;
		}
		this.runtimeSpec = runtimeSpec;
		this.pollingIntervalMs =
			config.fillerPollingInterval ?? this.defaultIntervalMs;

		this.phoenixFulfillmentConfigMap = new Map<
			number,
			PhoenixV1FulfillmentConfigAccount
		>();

		this.phoenixSubscribers = new Map<number, PhoenixSubscriber>();

		this.openbookFulfillmentConfigMap = new Map<
			number,
			OpenbookV2FulfillmentConfigAccount
		>();

		this.openbookSubscribers = new Map<number, OpenbookV2Subscriber>();

		this.initializeMetrics(config.metricsPort ?? this.globalConfig.metricsPort);

		this.priorityFeeSubscriber = priorityFeeSubscriber;
		this.priorityFeeSubscriber.updateAddresses([
			new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'), // Openbook SOL/USDC
			new PublicKey('4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg'), // Phoenix SOL/USDC
			new PublicKey('6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3'), // Drift USDC market
		]);

		this.revertOnFailure = config.revertOnFailure ?? true;
		this.simulateTxForCUEstimate = config.simulateTxForCUEstimate ?? true;
		this.rebalanceFiller = config.rebalanceFiller ?? true;
		logger.info(
			`${this.name}: revertOnFailure: ${this.revertOnFailure}, simulateTxForCUEstimate: ${this.simulateTxForCUEstimate}`
		);

		if (this.rebalanceFiller && this.runtimeSpec.driftEnv === 'mainnet-beta') {
			this.jupiterClient = new JupiterClient({
				connection: this.driftClient.connection,
			});
		}

		logger.info(
			`${this.name}: rebalancing enabled: ${this.jupiterClient !== undefined}`
		);

		this.lookupTableAccounts = lookupTableAccounts;

		this.userMap = userMap;

		if (!validMinimumGasAmount(config.minGasBalanceToFill)) {
			this.minGasBalanceToFill = 0.2 * LAMPORTS_PER_SOL;
		} else {
			this.minGasBalanceToFill = config.minGasBalanceToFill! * LAMPORTS_PER_SOL;
		}

		if (
			!validRebalanceSettledPnlThreshold(config.rebalanceSettledPnlThreshold)
		) {
			this.rebalanceSettledPnlThreshold = new BN(20);
		} else {
			this.rebalanceSettledPnlThreshold = new BN(
				config.rebalanceSettledPnlThreshold!
			);
		}

		logger.info(
			`${this.name}: minimumAmountToFill: ${this.minGasBalanceToFill}`
		);

		logger.info(
			`${this.name}: minimumAmountToSettle: ${this.rebalanceSettledPnlThreshold}`
		);

		if (this.driftClient.userAccountSubscriptionConfig.type === 'websocket') {
			this.orderSubscriber = new OrderSubscriber({
				driftClient: this.driftClient,
				subscriptionConfig: {
					type: 'websocket',
					skipInitialLoad: false,
					commitment: this.driftClient.opts?.commitment,
					resyncIntervalMs: 10_000,
				},
			});
		} else {
			this.orderSubscriber = new OrderSubscriber({
				driftClient: this.driftClient,
				subscriptionConfig: {
					type: 'polling',

					// we find crossing orders from the OrderSubscriber, so we need to poll twice
					// as frequently as main filler interval
					frequency: this.pollingIntervalMs / 2,

					commitment: this.driftClient.opts?.commitment,
				},
			});
		}

		this.bundleSender = bundleSender;
		this.blockhashSubscriber = blockhashSubscriber;

		this.pendingTxSigsToconfirm = new LRUCache<
			string,
			{
				ts: number;
				nodeFilled?: NodeToFill;
				fillTxId: number;
				txType: TxType;
			}
		>({
			max: 5_000,
			ttl: TX_TIMEOUT_THRESHOLD_MS,
			ttlResolution: 1000,
			disposeAfter: this.recordEvictedTxSig.bind(this),
		});

		this.expiredNodesSet = new LRUCache<string, boolean>({
			max: 10_000,
			ttl: TX_TIMEOUT_THRESHOLD_MS,
			ttlResolution: 1000,
		});
		this.clockSubscriber = new ClockSubscriber(driftClient.connection, {
			commitment: 'finalized',
			resubTimeoutMs: 5_000,
		});
	}

	protected initializeMetrics(metricsPort?: number) {
		if (this.globalConfig.disableMetrics) {
			logger.info(
				`${this.name}: globalConfig.disableMetrics is true, not initializing metrics`
			);
			return;
		}

		if (!metricsPort) {
			logger.info(
				`${this.name}: bot.metricsPort and global.metricsPort not set, not initializing metrics`
			);
			return;
		}

		if (this.metricsInitialized) {
			logger.error('Tried to initilaize metrics multiple times');
			return;
		}

		this.metrics = new Metrics(
			this.name,
			[
				new View({
					instrumentName: METRIC_TYPES.try_fill_duration_histogram,
					instrumentType: InstrumentType.HISTOGRAM,
					meterName: this.name,
					aggregation: new ExplicitBucketHistogramAggregation(
						Array.from(new Array(20), (_, i) => 0 + i * 5),
						true
					),
				}),
				new View({
					instrumentName: METRIC_TYPES.estimated_tx_cu_histogram,
					instrumentType: InstrumentType.HISTOGRAM,
					meterName: this.name,
					aggregation: new ExplicitBucketHistogramAggregation(
						Array.from(new Array(15), (_, i) => 0 + i * 100_000),
						true
					),
				}),
				new View({
					instrumentName: METRIC_TYPES.simulate_tx_duration_histogram,
					instrumentType: InstrumentType.HISTOGRAM,
					meterName: this.name,
					aggregation: new ExplicitBucketHistogramAggregation(
						Array.from(new Array(20), (_, i) => 50 + i * 50),
						true
					),
				}),
			],
			metricsPort!
		);
		this.bootTimeMs = Date.now();
		this.runtimeSpecsGauge = this.metrics.addGauge(
			METRIC_TYPES.runtime_specs,
			'Runtime sepcification of this program'
		);
		this.tryFillDurationHistogram = this.metrics.addHistogram(
			METRIC_TYPES.try_fill_duration_histogram,
			'Histogram of the duration of the try fill process'
		);
		this.estTxCuHistogram = this.metrics.addHistogram(
			METRIC_TYPES.estimated_tx_cu_histogram,
			'Histogram of the estimated fill cu used'
		);
		this.simulateTxHistogram = this.metrics.addHistogram(
			METRIC_TYPES.simulate_tx_duration_histogram,
			'Histogram of the duration of simulateTransaction RPC calls'
		);
		this.lastTryFillTimeGauge = this.metrics.addGauge(
			METRIC_TYPES.last_try_fill_time,
			'Last time that fill was attempted'
		);
		this.mutexBusyCounter = this.metrics.addCounter(
			METRIC_TYPES.mutex_busy,
			'Count of times the mutex was busy'
		);
		this.landedTxsCounter = this.metrics.addCounter(
			METRIC_TYPES.landed_transactions,
			'Count of fills that we successfully landed'
		);
		this.sentTxsCounter = this.metrics.addCounter(
			METRIC_TYPES.sent_transactions,
			'Count of transactions we sent out'
		);
		this.txSimErrorCounter = this.metrics.addCounter(
			METRIC_TYPES.tx_sim_error_count,
			'Count of errors from simulating transactions'
		);
		this.pendingTxSigsToConfirmGauge = this.metrics.addGauge(
			METRIC_TYPES.pending_tx_sigs_to_confirm,
			'Count of tx sigs that are pending confirmation'
		);
		this.pendingTxSigsLoopRateLimitedCounter = this.metrics.addCounter(
			METRIC_TYPES.pending_tx_sigs_loop_rate_limited,
			'Count of times the pending tx sigs loop was rate limited'
		);
		this.evictedPendingTxSigsToConfirmCounter = this.metrics.addCounter(
			METRIC_TYPES.evicted_pending_tx_sigs_to_confirm,
			'Count of tx sigs that were evicted from the pending tx sigs to confirm cache'
		);
		this.expiredNodesSetSize = this.metrics.addGauge(
			METRIC_TYPES.expired_nodes_set_size,
			'Count of nodes that are expired'
		);
		this.jitoConnectedGauge = this.metrics.addGauge(
			JITO_METRIC_TYPES.jito_connected,
			'Whether the jito bundle sender is connected'
		);
		this.jitoBundlesAcceptedGauge = this.metrics.addGauge(
			JITO_METRIC_TYPES.jito_bundles_accepted,
			'Count of jito bundles that were accepted'
		);
		this.jitoBundlesSimulationFailureGauge = this.metrics.addGauge(
			JITO_METRIC_TYPES.jito_bundles_simulation_failure,
			'Count of jito bundles that failed simulation'
		);
		this.jitoDroppedBundleGauge = this.metrics.addGauge(
			JITO_METRIC_TYPES.jito_dropped_bundle,
			'Count of jito bundles that were dropped'
		);
		this.jitoLandedTipsGauge = this.metrics.addGauge(
			JITO_METRIC_TYPES.jito_landed_tips,
			'Gauge of historic bundle tips that landed'
		);
		this.jitoBundleCount = this.metrics.addGauge(
			JITO_METRIC_TYPES.jito_bundle_count,
			'Count of jito bundles that were sent, and their status'
		);
		this.clockSubscriberTs = this.metrics.addGauge(
			METRIC_TYPES.clock_subscriber_ts,
			'Timestamp of the clock subscriber'
		);
		this.wallClockTs = this.metrics.addGauge(
			METRIC_TYPES.wall_clock_ts,
			'Timestamp of the wall clock'
		);

		this.metrics?.finalizeObservables();

		this.runtimeSpecsGauge.setLatestValue(this.bootTimeMs, this.runtimeSpec);
		this.metricsInitialized = true;
	}

	protected recordEvictedTxSig(
		_tsTxSigAdded: { ts: number; nodeFilled?: NodeToFill },
		txSig: string,
		reason: 'evict' | 'set' | 'delete'
	) {
		if (reason === 'evict') {
			logger.info(
				`${this.name}: Evicted tx sig ${txSig} from this.txSigsToConfirm`
			);
			const user = this.driftClient.getUser();
			this.evictedPendingTxSigsToConfirmCounter?.add(1, {
				...metricAttrFromUserAccount(
					user.userAccountPublicKey,
					user.getUserAccount()
				),
			});
		}
	}

	public async init() {
		logger.info(
			`${this.name} initing (filler cu boost: ${this.fillerConfig.triggerPriorityFeeMultiplier})`
		);

		const fillerSolBalance = await this.driftClient.connection.getBalance(
			this.driftClient.authority
		);
		this.hasEnoughSolToFill = fillerSolBalance >= this.minGasBalanceToFill;
		logger.info(
			`${this.name}: hasEnoughSolToFill: ${this.hasEnoughSolToFill}, balance: ${fillerSolBalance}`
		);

		const orderSubscriberInitStart = Date.now();
		logger.info(`Initializing OrderSubscriber...`);
		await this.orderSubscriber.subscribe();
		logger.info(
			`Initialized OrderSubscriber in ${
				Date.now() - orderSubscriberInitStart
			}ms`
		);

		const dlobProvider = getDLOBProviderFromOrderSubscriber(
			this.orderSubscriber
		);

		const userStatsMapStart = Date.now();
		logger.info(`Initializing UserStatsMap...`);
		this.userStatsMap = new UserStatsMap(this.driftClient);

		logger.info(
			`Initialized UserStatsMap in ${Date.now() - userStatsMapStart}ms`
		);

		const dlobSubscriberStart = Date.now();
		logger.info(`Initializing DLOBSubscriber...`);
		this.dlobSubscriber = new DLOBSubscriber({
			dlobSource: dlobProvider,
			slotSource: this.orderSubscriber,
			updateFrequency: this.pollingIntervalMs - 500,
			driftClient: this.driftClient,
		});
		await this.dlobSubscriber.subscribe();
		logger.info(
			`Initialized DLOBSubscriber in ${Date.now() - dlobSubscriberStart}`
		);

		({
			phoenixFulfillmentConfigs: this.phoenixFulfillmentConfigMap,
			openbookFulfillmentConfigs: this.openbookFulfillmentConfigMap,
			phoenixSubscribers: this.phoenixSubscribers,
			openbookSubscribers: this.openbookSubscribers,
		} = await initializeSpotFulfillmentAccounts(this.driftClient, true));

		if (!this.phoenixSubscribers) {
			throw new Error('phoenixSubscribers not initialized');
		}
		if (!this.openbookSubscribers) {
			throw new Error('openbookSubscribers not initialized');
		}

		this.lookupTableAccounts.push(
			...(await this.driftClient.fetchAllLookupTableAccounts())
		);

		await this.clockSubscriber.subscribe();
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];

		await this.dlobSubscriber!.unsubscribe();
		await this.userStatsMap!.unsubscribe();
		await this.orderSubscriber.unsubscribe();

		for (const phoenixSubscriber of this.phoenixSubscribers!.values()) {
			await phoenixSubscriber.unsubscribe();
		}

		for (const openbookSubscriber of this.openbookSubscribers!.values()) {
			await openbookSubscriber.unsubscribe();
		}
	}

	public async startIntervalLoop(_intervalMs?: number) {
		this.intervalIds.push(
			setInterval(this.trySpotFill.bind(this), this.pollingIntervalMs)
		);
		this.intervalIds.push(
			setInterval(this.confirmPendingTxSigs.bind(this), CONFIRM_TX_INTERVAL_MS)
		);
		if (this.bundleSender) {
			this.intervalIds.push(
				setInterval(this.recordJitoBundleStats.bind(this), 10_000)
			);
		}

		if (this.rebalanceFiller) {
			this.intervalIds.push(
				setInterval(this.rebalanceSpotFiller.bind(this), 60_000)
			);
		}

		logger.info(`${this.name} Bot started!`);
	}

	protected recordJitoBundleStats() {
		const user = this.driftClient.getUser();
		const bundleStats = this.bundleSender?.getBundleStats();
		if (bundleStats) {
			this.jitoBundlesAcceptedGauge?.setLatestValue(bundleStats.accepted, {
				...metricAttrFromUserAccount(
					user.userAccountPublicKey,
					user.getUserAccount()
				),
			});
			this.jitoBundlesSimulationFailureGauge?.setLatestValue(
				bundleStats.simulationFailure,
				{
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoDroppedBundleGauge?.setLatestValue(bundleStats.droppedPruned, {
				type: 'pruned',
				...metricAttrFromUserAccount(
					user.userAccountPublicKey,
					user.getUserAccount()
				),
			});
			this.jitoDroppedBundleGauge?.setLatestValue(
				bundleStats.droppedBlockhashExpired,
				{
					type: 'blockhash_expired',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoDroppedBundleGauge?.setLatestValue(
				bundleStats.droppedBlockhashNotFound,
				{
					type: 'blockhash_not_found',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
		}

		const tipStream = this.bundleSender?.getTipStream();
		if (tipStream) {
			this.jitoLandedTipsGauge?.setLatestValue(
				tipStream.landed_tips_25th_percentile,
				{
					percentile: 'p25',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoLandedTipsGauge?.setLatestValue(
				tipStream.landed_tips_50th_percentile,
				{
					percentile: 'p50',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoLandedTipsGauge?.setLatestValue(
				tipStream.landed_tips_75th_percentile,
				{
					percentile: 'p75',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoLandedTipsGauge?.setLatestValue(
				tipStream.landed_tips_95th_percentile,
				{
					percentile: 'p95',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoLandedTipsGauge?.setLatestValue(
				tipStream.landed_tips_99th_percentile,
				{
					percentile: 'p99',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
			this.jitoLandedTipsGauge?.setLatestValue(
				tipStream.ema_landed_tips_50th_percentile,
				{
					percentile: 'ema_p50',
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				}
			);
		}

		const bundleFailCount = this.bundleSender?.getBundleFailCount();
		const bundleLandedCount = this.bundleSender?.getLandedCount();
		const bundleDroppedCount = this.bundleSender?.getDroppedCount();
		this.jitoBundleCount?.setLatestValue(bundleFailCount ?? 0, {
			type: 'fail_count',
		});
		this.jitoBundleCount?.setLatestValue(bundleLandedCount ?? 0, {
			type: 'landed',
		});
		this.jitoBundleCount?.setLatestValue(bundleDroppedCount ?? 0, {
			type: 'dropped',
		});
	}

	protected async confirmPendingTxSigs() {
		const user = this.driftClient.getUser();
		this.pendingTxSigsToConfirmGauge?.setLatestValue(
			this.pendingTxSigsToconfirm.size,
			{
				...metricAttrFromUserAccount(
					user.userAccountPublicKey,
					user.getUserAccount()
				),
			}
		);
		this.expiredNodesSetSize?.setLatestValue(this.expiredNodesSet.size, {
			...metricAttrFromUserAccount(
				user.userAccountPublicKey,
				user.getUserAccount()
			),
		});
		const nextTimeCanRun =
			this.confirmLoopRateLimitTs + CONFIRM_TX_RATE_LIMIT_BACKOFF_MS;
		if (Date.now() < nextTimeCanRun) {
			logger.warn(
				`Skipping confirm loop due to rate limit, next run in ${
					nextTimeCanRun - Date.now()
				} ms`
			);
			return;
		}
		if (this.confirmLoopRunning) {
			return;
		}
		this.confirmLoopRunning = true;
		try {
			logger.info(`Confirming tx sigs: ${this.pendingTxSigsToconfirm.size}`);
			const start = Date.now();
			const txEntries = Array.from(this.pendingTxSigsToconfirm.entries());
			for (let i = 0; i < txEntries.length; i += TX_CONFIRMATION_BATCH_SIZE) {
				const txSigsBatch = txEntries.slice(i, i + TX_CONFIRMATION_BATCH_SIZE);
				const txs = await this.txConfirmationConnection?.getTransactions(
					txSigsBatch.map((tx) => tx[0]),
					{
						commitment: 'confirmed',
						maxSupportedTransactionVersion: 0,
					}
				);
				for (let j = 0; j < txs.length; j++) {
					const txResp = txs[j];
					const txConfirmationInfo = txSigsBatch[j];
					const txSig = txConfirmationInfo[0];
					const txAge = txConfirmationInfo[1].ts - Date.now();
					const nodeFilled = txConfirmationInfo[1].nodeFilled;
					const txType = txConfirmationInfo[1].txType;
					const fillTxId = txConfirmationInfo[1].fillTxId;
					if (txResp === null) {
						logger.info(
							`Tx not found, (fillTxId: ${fillTxId}) (txType: ${txType}): ${txSig}, tx age: ${
								txAge / 1000
							} s`
						);
						if (Math.abs(txAge) > TX_TIMEOUT_THRESHOLD_MS) {
							this.pendingTxSigsToconfirm.delete(txSig);
						}
					} else {
						logger.info(
							`Tx landed (fillTxId: ${fillTxId}) (txType: ${txType}): ${txSig}, tx age: ${
								txAge / 1000
							} s`
						);
						this.pendingTxSigsToconfirm.delete(txSig);
						if (txType === 'fill') {
							if (nodeFilled) {
								const result = await this.handleTransactionLogs(
									nodeFilled,
									txResp.meta?.logMessages
								);
								if (result) {
									this.landedTxsCounter?.add(result.filledNodes, {
										type: txType,
										...metricAttrFromUserAccount(
											user.userAccountPublicKey,
											user.getUserAccount()
										),
									});
								}
							}
						} else {
							this.landedTxsCounter?.add(1, {
								type: txType,
								...metricAttrFromUserAccount(
									user.userAccountPublicKey,
									user.getUserAccount()
								),
							});
						}
					}
					await sleepMs(500);
				}
			}
			logger.info(`Confirming tx sigs took: ${Date.now() - start} ms`);
		} catch (e) {
			const err = e as Error;
			if (err.message.includes('429')) {
				logger.info(`Confirming tx loop rate limited: ${err.message}`);
				this.confirmLoopRateLimitTs = Date.now();
				this.pendingTxSigsLoopRateLimitedCounter?.add(1, {
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				});
			} else {
				logger.error(`Other error confirming tx sigs: ${err.message}`);
			}
		} finally {
			this.confirmLoopRunning = false;
		}
	}

	protected getMaxSlot(): number {
		return Math.max(
			this.dlobSubscriber?.slotSource.getSlot() ?? 0,
			this.orderSubscriber.getSlot(),
			this.userMap!.getSlot()
		);
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime >
				Date.now() - 10 * this.pollingIntervalMs;
			if (!healthy) {
				logger.warn(`${this.name} watchdog timer expired`);
			}
		});

		return healthy;
	}

	private async getUserAccountAndSlotFromMap(
		key: string
	): Promise<DataAndSlot<UserAccount>> {
		const user = await this.userMap!.mustGetWithSlot(
			key,
			this.driftClient.userAccountSubscriptionConfig
		);
		return {
			data: user.data.getUserAccount(),
			slot: user.slot,
		};
	}

	private getSpotNodesForMarket(
		market: SpotMarketAccount,
		dlob: DLOB
	): {
		nodesToFill: NodesToFillWithContext;
		nodesToTrigger: Array<NodeToTrigger>;
	} {
		const oraclePriceData = this.driftClient.getOracleDataForSpotMarket(
			market.marketIndex
		);

		const phoenixSubscriber = this.phoenixSubscribers!.get(market.marketIndex);
		const phoenixBestBid = phoenixSubscriber?.getBestBid();
		const phoenixBestAsk = phoenixSubscriber?.getBestAsk();

		const openbookSubscriber = this.openbookSubscribers!.get(
			market.marketIndex
		);
		const openbookBestBid = openbookSubscriber?.getBestBid();
		const openbookBestAsk = openbookSubscriber?.getBestAsk();

		const [fallbackBidPrice, fallbackBidSource] = this.pickFallbackPrice(
			openbookBestBid,
			phoenixBestBid,
			'bid'
		);

		const [fallbackAskPrice, fallbackAskSource] = this.pickFallbackPrice(
			openbookBestAsk,
			phoenixBestAsk,
			'ask'
		);

		const fillSlot = this.orderSubscriber.getSlot();

		const nodesToFill = dlob.findNodesToFill(
			market.marketIndex,
			fallbackBidPrice,
			fallbackAskPrice,
			fillSlot,
			this.clockSubscriber.getUnixTs() - EXPIRE_ORDER_BUFFER_SEC,
			MarketType.SPOT,
			oraclePriceData,
			this.driftClient.getStateAccount(),
			this.driftClient.getSpotMarketAccount(market.marketIndex)!
		);

		const nodesToTrigger = dlob.findNodesToTrigger(
			market.marketIndex,
			fillSlot,
			oraclePriceData.price,
			MarketType.SPOT,
			this.driftClient.getStateAccount()
		);

		return {
			nodesToFill: { nodesToFill, fallbackAskSource, fallbackBidSource },
			nodesToTrigger,
		};
	}

	private pickFallbackPrice(
		openbookPrice: BN | undefined,
		phoenixPrice: BN | undefined,
		side: 'bid' | 'ask'
	): [BN | undefined, FallbackLiquiditySource | undefined] {
		if (openbookPrice && phoenixPrice) {
			if (side === 'bid') {
				return openbookPrice.gt(phoenixPrice)
					? [openbookPrice, 'openbook']
					: [phoenixPrice, 'phoenix'];
			} else {
				return openbookPrice.lt(phoenixPrice)
					? [openbookPrice, 'openbook']
					: [phoenixPrice, 'phoenix'];
			}
		}

		if (openbookPrice) {
			return [openbookPrice, 'openbook'];
		}

		if (phoenixPrice) {
			return [phoenixPrice, 'phoenix'];
		}

		return [undefined, undefined];
	}

	private async getNodeFillInfo(nodeToFill: NodeToFill): Promise<{
		makerInfos: Array<DataAndSlot<MakerInfo>>;
		takerUserPubKey: string;
		takerUser: UserAccount;
		takerUserSlot: number;
		marketType: MarketType;
	}> {
		const makerInfos: Array<DataAndSlot<MakerInfo>> = [];

		if (nodeToFill.makerNodes.length > 0) {
			let makerNodesMap: MakerNodeMap = new Map<string, DLOBNode[]>();
			for (const makerNode of nodeToFill.makerNodes) {
				if (this.isDLOBNodeThrottled(makerNode)) {
					continue;
				}

				if (!makerNode.userAccount) {
					continue;
				}

				if (makerNodesMap.has(makerNode.userAccount!)) {
					makerNodesMap.get(makerNode.userAccount!)!.push(makerNode);
				} else {
					makerNodesMap.set(makerNode.userAccount!, [makerNode]);
				}
			}

			if (makerNodesMap.size > MAX_MAKERS_PER_FILL) {
				logger.info(`selecting from ${makerNodesMap.size} makers`);
				makerNodesMap = selectMakers(makerNodesMap);
				logger.info(`selected: ${Array.from(makerNodesMap.keys()).join(',')}`);
			}

			for (const [makerAccount, makerNodes] of makerNodesMap) {
				const makerNode = makerNodes[0];

				const makerUserAccount = await this.getUserAccountAndSlotFromMap(
					makerAccount
				);
				const makerAuthority = makerUserAccount.data.authority;
				const makerUserStats = (
					await this.userStatsMap!.mustGet(makerAuthority.toString())
				).userStatsAccountPublicKey;
				makerInfos.push({
					slot: makerUserAccount.slot,
					data: {
						maker: new PublicKey(makerAccount),
						makerUserAccount: makerUserAccount.data,
						order: makerNode.order,
						makerStats: makerUserStats,
					},
				});
			}
		}

		const node = nodeToFill.node;
		const order = node.order!;

		const user = await this.userMap!.mustGetWithSlot(
			node.userAccount!.toString(),
			this.driftClient.userAccountSubscriptionConfig
		);

		return Promise.resolve({
			makerInfos,
			takerUser: user.data.getUserAccount(),
			takerUserSlot: user.slot,
			takerUserPubKey: node.userAccount!.toString(),
			marketType: order.marketType,
		});
	}

	/**
	 * Checks if the node is still throttled, if not, clears it from the throttledNodes map
	 * @param throttleKey key in throttleMap
	 * @returns  true if throttleKey is still throttled, false if throttleKey is no longer throttled
	 */
	protected isThrottledNodeStillThrottled(throttleKey: string): boolean {
		const lastFillAttempt = this.throttledNodes.get(throttleKey) || 0;
		if (lastFillAttempt + FILL_ORDER_THROTTLE_BACKOFF > Date.now()) {
			return true;
		} else {
			this.clearThrottledNode(throttleKey);
			return false;
		}
	}

	protected isDLOBNodeThrottled(dlobNode: DLOBNode): boolean {
		if (!dlobNode.userAccount || !dlobNode.order) {
			return false;
		}

		// first check if the userAccount itself is throttled
		const userAccountPubkey = dlobNode.userAccount;
		if (this.throttledNodes.has(userAccountPubkey)) {
			if (this.isThrottledNodeStillThrottled(userAccountPubkey)) {
				return true;
			} else {
				return false;
			}
		}

		// then check if the specific order is throttled
		const orderSignature = getFillSignatureFromUserAccountAndOrderId(
			dlobNode.userAccount,
			dlobNode.order.orderId.toString()
		);
		if (this.throttledNodes.has(orderSignature)) {
			if (this.isThrottledNodeStillThrottled(orderSignature)) {
				return true;
			} else {
				return false;
			}
		}

		return false;
	}

	private setThrottleNode(nodeSignature: string) {
		this.throttledNodes.set(nodeSignature, Date.now());
	}

	private clearThrottledNode(nodeSignature: string) {
		this.throttledNodes.delete(nodeSignature);
	}

	private pruneThrottledNode() {
		if (this.throttledNodes.size > THROTTLED_NODE_SIZE_TO_PRUNE) {
			for (const [key, value] of this.throttledNodes.entries()) {
				if (value + 2 * FILL_ORDER_THROTTLE_BACKOFF > Date.now()) {
					this.throttledNodes.delete(key);
				}
			}
		}
	}

	private removeTriggeringNodes(node: NodeToTrigger) {
		this.triggeringNodes.delete(getNodeToTriggerSignature(node));
	}

	private async sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Iterates through a tx's logs and handles it appropriately e.g. throttling users, updating metrics, etc.)
	 *
	 * @param nodesFilled nodes that we sent a transaction to fill
	 * @param logs logs from tx.meta.logMessages or this.driftClient.program._events._eventParser.parseLogs
	 *
	 * @returns number of nodes successfully filled, and whether the tx exceeded CUs
	 */
	private async handleTransactionLogs(
		nodeFilled: NodeToFill,
		logs: string[] | null | undefined
	): Promise<{ filledNodes: number; exceededCUs: boolean }> {
		if (!logs) {
			return {
				filledNodes: 0,
				exceededCUs: false,
			};
		}

		let inFillIx = false;
		let errorThisFillIx = false;
		let successCount = 0;
		for (const log of logs) {
			if (log === null) {
				logger.error(`log is null`);
				continue;
			}

			const node = nodeFilled.node;
			const order = node.order!;

			if (isEndIxLog(this.driftClient.program.programId.toBase58(), log)) {
				if (!errorThisFillIx) {
					successCount++;
				}

				inFillIx = false;
				errorThisFillIx = false;
				continue;
			}

			if (isIxLog(log)) {
				if (isFillIxLog(log)) {
					inFillIx = true;
					errorThisFillIx = false;
				} else {
					inFillIx = false;
				}
				continue;
			}

			if (!inFillIx) {
				// this is not a log for a fill instruction
				continue;
			}

			// try to handle the log line
			const orderIdDoesNotExist = isOrderDoesNotExistLog(log);
			if (orderIdDoesNotExist) {
				logger.error(
					`spot node filled: ${node.userAccount!.toString()}, ${
						order.orderId
					}; does not exist (filled by someone else); ${log}`
				);
				this.throttledNodes.delete(getNodeToFillSignature(nodeFilled));
				errorThisFillIx = true;
				continue;
			}

			const makerBreachedMaintenanceMargin =
				isMakerBreachedMaintenanceMarginLog(log);
			if (makerBreachedMaintenanceMargin) {
				const makerNode = getMakerNodeFromNodeToFill(nodeFilled);
				if (!makerNode) {
					logger.error(
						`Got maker breached maint. margin log, but don't have a maker node: ${log}\n${JSON.stringify(
							nodeFilled,
							null,
							2
						)}`
					);
					continue;
				}
				const order = makerNode.order!;
				const makerNodeSignature = getFillSignatureFromUserAccountAndOrderId(
					makerNode.userAccount!.toString(),
					order.orderId.toString()
				);
				logger.error(
					`maker breach maint. margin, assoc node: ${makerNode.userAccount!.toString()}, ${
						order.orderId
					}; (throttling ${makerNodeSignature}); ${log}`
				);
				this.throttledNodes.set(makerNodeSignature, Date.now());
				errorThisFillIx = true;

				this.driftClient
					.forceCancelOrders(
						new PublicKey(makerNode.userAccount!),
						(
							await this.userMap!.mustGet(
								makerNode.userAccount!.toString(),
								this.driftClient.userAccountSubscriptionConfig
							)
						).getUserAccount()
					)
					.then((txSig) => {
						logger.info(
							`Force cancelled orders for maker ${makerNode.userAccount!} due to breach of maintenance margin. Tx: ${txSig}`
						);
					})
					.catch((e) => {
						console.error(e);
						logger.error(
							`Failed to send ForceCancelOrder Tx (error above), maker (${makerNode.userAccount!.toString()}) breach maint margin:`
						);
						webhookMessage(
							`[${this.name}]: :x: error processing fill tx logs:\n${
								e.stack ? e.stack : e.message
							}`
						);
					});

				continue;
			}

			const takerBreachedMaintenanceMargin =
				isTakerBreachedMaintenanceMarginLog(log);
			if (takerBreachedMaintenanceMargin) {
				const node = nodeFilled.node!;
				const order = node.order!;
				const takerNodeSignature = getFillSignatureFromUserAccountAndOrderId(
					node.userAccount!.toString(),
					order.orderId.toString()
				);
				logger.error(
					`taker breach maint. margin, assoc node: ${node.userAccount!.toString()}, ${
						order.orderId
					}; (throttling ${takerNodeSignature} and force cancelling orders); ${log}`
				);
				this.throttledNodes.set(takerNodeSignature, Date.now());
				errorThisFillIx = true;

				this.driftClient
					.forceCancelOrders(
						new PublicKey(node.userAccount!),
						(
							await this.userMap!.mustGet(
								node.userAccount!.toString(),
								this.driftClient.userAccountSubscriptionConfig
							)
						).getUserAccount()
					)
					.then((txSig) => {
						logger.info(
							`Force cancelled orders for user ${node.userAccount!} due to breach of maintenance margin. Tx: ${txSig}`
						);
					})
					.catch((e) => {
						console.error(e);
						logger.error(
							`Failed to send ForceCancelOrder Tx (error above), taker (${node.userAccount!}) breach maint margin:`
						);
						webhookMessage(
							`[${this.name}]: :x: error processing fill tx logs:\n${
								e.stack ? e.stack : e.message
							}`
						);
					});

				continue;
			}
		}

		if (logs.length > 0) {
			if (
				logs[logs.length - 1].includes('exceeded CUs meter at BPF instruction')
			) {
				return {
					filledNodes: successCount,
					exceededCUs: true,
				};
			}
		}

		return {
			filledNodes: successCount,
			exceededCUs: false,
		};
	}

	private async processBulkFillTxLogs(
		fillTxId: number,
		nodeToFill: NodeToFill,
		txSig: string,
		tx?: VersionedTransaction
	): Promise<number> {
		let txResp: VersionedTransactionResponse | null = null;
		let attempts = 0;
		while (txResp === null && attempts < CONFIRM_TX_ATTEMPTS) {
			logger.info(
				`(fillTxId: ${fillTxId}) waiting for https://solscan.io/tx/${txSig} to be confirmed`
			);
			txResp = await this.driftClient.connection.getTransaction(txSig, {
				commitment: 'confirmed',
				maxSupportedTransactionVersion: 0,
			});

			if (txResp === null) {
				if (tx !== undefined) {
					await this.driftClient.txSender.sendVersionedTransaction(
						tx,
						[],
						this.driftClient.opts
					);
				}
				attempts++;
				await this.sleep(1000);
			}
		}

		if (txResp === null) {
			logger.error(
				`(fillTxId: ${fillTxId})tx ${txSig} not found after ${attempts}`
			);
			return 0;
		}

		return (
			await this.handleTransactionLogs(nodeToFill, txResp.meta!.logMessages!)
		).filledNodes;
	}

	/**
	 * Queues up the txSig to be confirmed in a slower loop, and have tx logs handled
	 * @param txSig
	 */
	protected async registerTxSigToConfirm(
		txSig: TransactionSignature,
		now: number,
		nodeFilled: NodeToFill | undefined,
		fillTxId: number,
		txType: TxType
	) {
		this.pendingTxSigsToconfirm.set(txSig, {
			ts: now,
			nodeFilled,
			fillTxId,
			txType,
		});
		const user = this.driftClient.getUser();
		this.sentTxsCounter?.add(1, {
			txType,
			...metricAttrFromUserAccount(
				user.userAccountPublicKey,
				user.getUserAccount()
			),
		});
	}

	private async sendTxThroughJito(
		tx: VersionedTransaction,
		metadata: number | string,
		txSig?: string
	) {
		if (this.bundleSender === undefined) {
			logger.error(`Called sendTxThroughJito without jito properly enabled`);
			return;
		}
		if (
			this.bundleSender?.strategy === 'jito-only' ||
			this.bundleSender?.strategy === 'hybrid'
		) {
			const slotsUntilNextLeader = this.bundleSender?.slotsUntilNextLeader();
			if (slotsUntilNextLeader !== undefined) {
				this.bundleSender.sendTransactions(
					[tx],
					`(fillTxId: ${metadata})`,
					txSig,
					false
				);
			}
		}
	}

	private usingJito(): boolean {
		return this.bundleSender !== undefined;
	}

	private canSendOutsideJito(): boolean {
		return (
			!this.usingJito() ||
			this.bundleSender?.strategy === 'non-jito-only' ||
			this.bundleSender?.strategy === 'hybrid'
		);
	}

	private slotsUntilJitoLeader(): number | undefined {
		if (!this.usingJito()) {
			return undefined;
		}
		return this.bundleSender?.slotsUntilNextLeader();
	}

	private shouldBuildForBundle(): boolean {
		if (!this.usingJito()) {
			return false;
		}
		if (this.globalConfig.onlySendDuringJitoLeader === true) {
			const slotsUntilJito = this.slotsUntilJitoLeader();
			if (slotsUntilJito === undefined) {
				return false;
			}
			return slotsUntilJito < SLOTS_UNTIL_JITO_LEADER_TO_SEND;
		}
		if (!this.bundleSender?.connected()) {
			return false;
		}
		return true;
	}

	private async getBlockhashForTx(): Promise<string> {
		const cachedBlockhash = this.blockhashSubscriber.getLatestBlockhash(
			CACHED_BLOCKHASH_OFFSET
		);
		if (cachedBlockhash) {
			return cachedBlockhash.blockhash as string;
		}

		const recentBlockhash =
			await this.driftClient.connection.getLatestBlockhash({
				commitment: 'confirmed',
			});

		return recentBlockhash.blockhash;
	}

	protected async sendFillTxAndParseLogs(
		fillTxId: number,
		nodeSent: NodeToFill,
		tx: VersionedTransaction,
		buildForBundle: boolean,
		lutAccounts: Array<AddressLookupTableAccount>
	) {
		const txSigners = [this.driftClient.wallet.payer];
		// @ts-ignore
		tx.sign(txSigners);
		const txSig = bs58.encode(tx.signatures[0]);
		this.registerTxSigToConfirm(txSig, Date.now(), nodeSent, fillTxId, 'fill');

		if (buildForBundle) {
			await this.sendTxThroughJito(tx, fillTxId, txSig);
		} else if (this.canSendOutsideJito()) {
			const { estTxSize, accountMetas, writeAccs, txAccounts } =
				getTransactionAccountMetas(tx, lutAccounts);

			this.driftClient.txSender
				.sendVersionedTransaction(tx, [], this.driftClient.opts, true)
				.then(async (txSig) => {
					logger.info(
						`Filled spot order (fillTxId: ${fillTxId}): https://solscan.io/tx/${txSig.txSig}`
					);

					const parseLogsStart = Date.now();
					this.processBulkFillTxLogs(fillTxId, nodeSent, txSig.txSig, tx)
						.then((successfulFills) => {
							const processBulkFillLogsDuration = Date.now() - parseLogsStart;
							logger.info(
								`parse logs took ${processBulkFillLogsDuration}ms, successfulFills ${successfulFills} (fillTxId: ${fillTxId})`
							);
						})
						.catch((err) => {
							const e = err as Error;
							logger.error(
								`Failed to process fill tx logs (fillTxId: ${fillTxId}):\n${
									e.stack ? e.stack : e.message
								}`
							);
							webhookMessage(
								`[${this.name}]: :x: error processing fill tx logs:\n${
									e.stack ? e.stack : e.message
								}`
							);
						});
				})
				.catch(async (e) => {
					const simError = e as SendTransactionError;
					logger.error(
						`Failed to send packed tx txAccountKeys: ${txAccounts} (${writeAccs} writeable) (fillTxId: ${fillTxId}), error: ${simError.message}`
					);

					if (e.message.includes('too large:')) {
						logger.error(
							`[${
								this.name
							}]: :boxing_glove: Tx too large, estimated to be ${estTxSize} (fillTxId: ${fillTxId}). ${
								e.message
							}\n${JSON.stringify(accountMetas)}`
						);
						webhookMessage(
							`[${
								this.name
							}]: :boxing_glove: Tx too large (fillTxId: ${fillTxId}). ${
								e.message
							}\n${JSON.stringify(accountMetas)}`
						);
						return;
					}

					if (simError.logs && simError.logs.length > 0) {
						await this.handleTransactionLogs(nodeSent, simError.logs);

						const errorCode = getErrorCode(e);
						logger.error(
							`Failed to send tx, sim error (fillTxId: ${fillTxId}) error code: ${errorCode}`
						);

						if (
							errorCode &&
							!errorCodesToSuppress.includes(errorCode) &&
							!(e as Error).message.includes('Transaction was not confirmed')
						) {
							const user = this.driftClient.getUser();
							this.txSimErrorCounter?.add(1, {
								errorCode: errorCode.toString(),
								...metricAttrFromUserAccount(
									user.userAccountPublicKey,
									user.getUserAccount()
								),
							});

							logger.error(
								`Failed to send tx, sim error (fillTxId: ${fillTxId}) sim logs:\n${
									simError.logs ? simError.logs.join('\n') : ''
								}\n${e.stack || e}`
							);

							webhookMessage(
								`[${this.name}]: :x: error simulating tx:\n${
									simError.logs ? simError.logs.join('\n') : ''
								}\n${e.stack || e}`,
								process.env.TX_LOG_WEBHOOK_URL
							);
						}
					}
				})
				.finally(() => {
					this.clearThrottledNode(getNodeToFillSignature(nodeSent));
				});
		}
	}

	/**
	 *
	 * @param fillTxId id of current fill
	 * @param nodeToFill taker node to fill with list of makers to use
	 * @returns true if successful, false if fail, and should retry with fewer makers
	 */
	private async fillMultiMakerSpotNodes(
		fillTxId: number,
		nodeToFill: NodeToFill,
		buildForBundle: boolean,
		spotPrecision: BN
	): Promise<boolean> {
		try {
			const {
				makerInfos,
				takerUser,
				takerUserPubKey,
				takerUserSlot,
				marketType,
			} = await this.getNodeFillInfo(nodeToFill);

			logMessageForNodeToFill(
				nodeToFill,
				takerUserPubKey,
				takerUserSlot,
				makerInfos,
				this.getMaxSlot(),
				fillTxId,
				'multiMakerSpotFill',
				this.revertOnFailure ?? false,
				false,
				undefined,
				spotPrecision
			);

			if (!isVariant(marketType, 'spot')) {
				throw new Error('expected spot market type');
			}

			let makerInfosToUse = makerInfos;
			const buildTxWithMakerInfos = async (
				makers: DataAndSlot<MakerInfo>[]
			): Promise<SimulateAndGetTxWithCUsResponse> => {
				const ixs: Array<TransactionInstruction> = [
					ComputeBudgetProgram.setComputeUnitLimit({
						units: 1_400_000,
					}),
				];
				if (buildForBundle) {
					ixs.push(this.bundleSender!.getTipIx());
				} else {
					ixs.push(
						ComputeBudgetProgram.setComputeUnitPrice({
							microLamports: Math.floor(
								this.priorityFeeSubscriber.getCustomStrategyResult()
							),
						})
					);
				}

				ixs.push(
					await this.driftClient.getFillSpotOrderIx(
						new PublicKey(takerUserPubKey),
						takerUser,
						nodeToFill.node.order!,
						undefined,
						makers.map((m) => m.data)
					)
				);

				if (this.revertOnFailure) {
					ixs.push(await this.driftClient.getRevertFillIx());
				}
				const simResult = await simulateAndGetTxWithCUs({
					ixs,
					connection: this.driftClient.connection,
					payerPublicKey: this.driftClient.wallet.publicKey,
					lookupTableAccounts: this.lookupTableAccounts,
					cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
					doSimulation: this.simulateTxForCUEstimate,
					recentBlockhash: await this.getBlockhashForTx(),
					dumpTx: DUMP_TXS_IN_SIM,
				});
				const user = this.driftClient.getUser();
				this.simulateTxHistogram?.record(simResult.simTxDuration, {
					type: 'multiMakerFill',
					simError: simResult.simError !== null,
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				});
				this.estTxCuHistogram?.record(simResult.cuEstimate, {
					type: 'multiMakerFill',
					simError: simResult.simError !== null,
					...metricAttrFromUserAccount(
						user.userAccountPublicKey,
						user.getUserAccount()
					),
				});

				return simResult;
			};

			let simResult = await buildTxWithMakerInfos(makerInfosToUse);
			let txAccounts = simResult.tx.message.getAccountKeys({
				addressLookupTableAccounts: this.lookupTableAccounts,
			}).length;
			let attempt = 0;
			while (txAccounts > MAX_ACCOUNTS_PER_TX && makerInfosToUse.length > 0) {
				logger.info(
					`(fillTxId: ${fillTxId} attempt ${attempt++}) Too many accounts, remove 1 and try again (had ${
						makerInfosToUse.length
					} maker and ${txAccounts} accounts)`
				);
				makerInfosToUse = makerInfosToUse.slice(0, makerInfosToUse.length - 1);
				simResult = await buildTxWithMakerInfos(makerInfosToUse);
				txAccounts = simResult.tx.message.getAccountKeys({
					addressLookupTableAccounts: this.lookupTableAccounts,
				}).length;
			}

			if (makerInfosToUse.length === 0) {
				logger.error(
					`No makerInfos left to use for multi maker spot node (fillTxId: ${fillTxId})`
				);
				return true;
			}

			logger.info(
				`tryFillMultiMakerSpotNodes estimated CUs: ${simResult.cuEstimate} (fillTxId: ${fillTxId})`
			);

			if (simResult.simError) {
				logger.error(
					`Error simulating multi maker spot node (fillTxId: ${fillTxId}): ${JSON.stringify(
						simResult.simError
					)}\nTaker slot: ${takerUserSlot}\nMaker slots: ${makerInfosToUse
						.map((m) => `  ${m.data.maker.toBase58()}: ${m.slot}`)
						.join('\n')}`
				);
				handleSimResultError(
					simResult,
					errorCodesToSuppress,
					`${this.name}: (fillTxId: ${fillTxId})`
				);
				if (simResult.simTxLogs) {
					const { exceededCUs } = await this.handleTransactionLogs(
						nodeToFill,
						simResult.simTxLogs
					);
					if (exceededCUs) {
						return false;
					}
				}
			} else {
				if (!this.dryRun) {
					if (this.hasEnoughSolToFill) {
						this.sendFillTxAndParseLogs(
							fillTxId,
							nodeToFill,
							simResult.tx,
							buildForBundle,
							this.lookupTableAccounts
						);
					} else {
						logger.info(
							`not sending tx because we don't have enough SOL to fill (fillTxId: ${fillTxId})`
						);
					}
				} else {
					logger.info(`dry run, not sending tx (fillTxId: ${fillTxId})`);
				}
			}
		} catch (e) {
			if (e instanceof Error) {
				logger.error(
					`Error filling multi maker spot node (fillTxId: ${fillTxId}): ${
						e.stack ? e.stack : e.message
					}`
				);
			}
		}

		return true;
	}

	/**
	 * It's difficult to estimate CU cost of multi maker ix, so we'll just send it in its own transaction.
	 * This will keep retrying with a smaller set of makers until it succeeds or runs out of makers.
	 * @param nodeToFill node with multiple makers
	 */
	private async tryFillMultiMakerSpotNode(
		fillTxId: number,
		nodeToFill: NodeToFill,
		buildForBundle: boolean,
		spotPrecision: BN
	) {
		let nodeWithMakerSet = nodeToFill;
		while (
			!(await this.fillMultiMakerSpotNodes(
				fillTxId,
				nodeWithMakerSet,
				buildForBundle,
				spotPrecision
			))
		) {
			const newMakerSet = nodeWithMakerSet.makerNodes
				.sort(() => 0.5 - Math.random())
				.slice(0, Math.ceil(nodeWithMakerSet.makerNodes.length / 2));
			nodeWithMakerSet = {
				node: nodeWithMakerSet.node,
				makerNodes: newMakerSet,
			};
			if (newMakerSet.length === 0) {
				logger.error(
					`No makers left to use for multi maker spot node (fillTxId: ${fillTxId})`
				);
				return;
			}
		}
	}

	private async tryFillSpotNode(
		nodeToFill: NodeToFill,
		fillTxId: number,
		buildForBundle: boolean,
		fallbackAskSource?: FallbackLiquiditySource,
		fallbackBidSource?: FallbackLiquiditySource
	) {
		const node = nodeToFill.node!;
		const order = node.order!;
		const spotMarket = this.driftClient.getSpotMarketAccount(
			order.marketIndex
		)!;
		const spotMarketPrecision = TEN.pow(new BN(spotMarket.decimals));

		if (nodeToFill.makerNodes.length > 0) {
			// do multi maker fills in a separate tx since they're larger
			return this.tryFillMultiMakerSpotNode(
				fillTxId,
				nodeToFill,
				buildForBundle,
				spotMarketPrecision
			);
		}

		const fallbackSource = isVariant(order.direction, 'short')
			? fallbackBidSource
			: fallbackAskSource;

		const { takerUser, takerUserPubKey, takerUserSlot, marketType } =
			await this.getNodeFillInfo(nodeToFill);

		if (!isVariant(marketType, 'spot')) {
			throw new Error('expected spot market type');
		}

		let fulfillmentConfig:
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount
			| undefined = undefined;
		if (fallbackSource === 'phoenix') {
			const cfg = this.phoenixFulfillmentConfigMap.get(
				nodeToFill.node.order!.marketIndex
			);
			if (cfg && isVariant(cfg.status, 'enabled')) {
				fulfillmentConfig = cfg;
			}
		} else if (fallbackSource === 'openbook') {
			const cfg = this.openbookFulfillmentConfigMap.get(
				nodeToFill.node.order!.marketIndex
			);
			if (cfg && isVariant(cfg.status, 'enabled')) {
				fulfillmentConfig = cfg;
			}
		}

		logMessageForNodeToFill(
			nodeToFill,
			takerUserPubKey,
			takerUserSlot,
			[],
			this.getMaxSlot(),
			fillTxId,
			'fillSpotNode',
			this.revertOnFailure ?? false,
			false,
			fallbackSource,
			spotMarketPrecision
		);

		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_400_000,
			}),
		];
		if (buildForBundle) {
			ixs.push(this.bundleSender!.getTipIx());
		} else {
			const priorityFee = Math.floor(
				this.priorityFeeSubscriber.getCustomStrategyResult()
			);
			logger.info(`(fillTxId: ${fillTxId}) Using priority fee: ${priorityFee}`);
			ixs.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: priorityFee,
				})
			);
		}

		ixs.push(
			await this.driftClient.getFillSpotOrderIx(
				new PublicKey(takerUserPubKey),
				takerUser,
				nodeToFill.node.order,
				fulfillmentConfig
			)
		);

		if (this.revertOnFailure) {
			ixs.push(await this.driftClient.getRevertFillIx());
		}

		const simResult = await simulateAndGetTxWithCUs({
			ixs,
			connection: this.driftClient.connection,
			payerPublicKey: this.driftClient.wallet.publicKey,
			lookupTableAccounts: this.lookupTableAccounts,
			cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
			doSimulation: this.simulateTxForCUEstimate,
			recentBlockhash: await this.getBlockhashForTx(),
			dumpTx: DUMP_TXS_IN_SIM,
		});
		const user = this.driftClient.getUser();
		this.simulateTxHistogram?.record(simResult.simTxDuration, {
			type: 'spotFill',
			simError: simResult.simError !== null,
			...metricAttrFromUserAccount(
				user.userAccountPublicKey,
				user.getUserAccount()
			),
		});
		this.estTxCuHistogram?.record(simResult.cuEstimate, {
			type: 'spotFill',
			simError: simResult.simError !== null,
			...metricAttrFromUserAccount(
				user.userAccountPublicKey,
				user.getUserAccount()
			),
		});

		if (this.simulateTxForCUEstimate && simResult.simError) {
			logger.error(
				`simError: ${JSON.stringify(
					simResult.simError
				)} (fillTxId: ${fillTxId})`
			);
			handleSimResultError(
				simResult,
				errorCodesToSuppress,
				`${this.name}: (fillTxId: ${fillTxId})`
			);
			if (simResult.simTxLogs) {
				await this.handleTransactionLogs(nodeToFill, simResult.simTxLogs);
			}
		} else {
			if (this.dryRun) {
				logger.info(`dry run, not filling spot order (fillTxId: ${fillTxId})`);
			} else {
				if (this.hasEnoughSolToFill) {
					this.sendFillTxAndParseLogs(
						fillTxId,
						nodeToFill,
						simResult.tx,
						buildForBundle,
						this.lookupTableAccounts
					);
				} else {
					logger.info(
						`not sending tx because we don't have enough SOL to fill (fillTxId: ${fillTxId})`
					);
				}
			}
		}
	}

	private filterTriggerableNodes(nodeToTrigger: NodeToTrigger): boolean {
		if (nodeToTrigger.node.haveTrigger) {
			return false;
		}

		const now = Date.now();
		const nodeToFillSignature = getNodeToTriggerSignature(nodeToTrigger);
		const timeStartedToTriggerNode =
			this.triggeringNodes.get(nodeToFillSignature);
		if (timeStartedToTriggerNode) {
			if (timeStartedToTriggerNode + TRIGGER_ORDER_COOLDOWN_MS > now) {
				return false;
			}
		}

		return true;
	}

	private async executeFillableSpotNodesForMarket(
		fillableNodes: Array<NodesToFillWithContext>,
		buildForBundle: boolean
	) {
		for (const nodesToFillWithContext of fillableNodes) {
			for (const nodeToFill of nodesToFillWithContext.nodesToFill) {
				await this.tryFillSpotNode(
					nodeToFill,
					this.fillTxId++,
					buildForBundle,
					nodesToFillWithContext.fallbackAskSource,
					nodesToFillWithContext.fallbackBidSource
				);
			}
		}
	}

	private async executeTriggerableSpotNodesForMarket(
		triggerableNodes: Array<NodeToTrigger>,
		buildForBundle: boolean
	) {
		for (const nodeToTrigger of triggerableNodes) {
			nodeToTrigger.node.haveTrigger = true;

			const nodeSignature = getNodeToTriggerSignature(nodeToTrigger);
			this.triggeringNodes.set(nodeSignature, Date.now());

			const user = await this.userMap!.mustGetWithSlot(
				nodeToTrigger.node.userAccount.toString(),
				this.driftClient.userAccountSubscriptionConfig
			);
			const userAccount = user.data.getUserAccount();

			const ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 1_400_000,
				}),
			];

			if (buildForBundle) {
				ixs.push(this.bundleSender!.getTipIx());
			} else {
				ixs.push(
					ComputeBudgetProgram.setComputeUnitPrice({
						microLamports: Math.floor(
							this.priorityFeeSubscriber.getCustomStrategyResult() *
								this.driftClient.txSender.getSuggestedPriorityFeeMultiplier() *
								(this.fillerConfig.triggerPriorityFeeMultiplier ?? 1.0)
						),
					})
				);
			}

			ixs.push(
				await this.driftClient.getTriggerOrderIx(
					new PublicKey(nodeToTrigger.node.userAccount),
					userAccount,
					nodeToTrigger.node.order
				)
			);

			if (this.revertOnFailure) {
				ixs.push(await this.driftClient.getRevertFillIx());
			}

			const simResult = await simulateAndGetTxWithCUs({
				ixs,
				connection: this.driftClient.connection,
				payerPublicKey: this.driftClient.wallet.publicKey,
				lookupTableAccounts: this.lookupTableAccounts,
				cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
				doSimulation: this.simulateTxForCUEstimate,
				recentBlockhash: await this.getBlockhashForTx(),
				dumpTx: DUMP_TXS_IN_SIM,
			});
			const driftUser = this.driftClient.getUser();
			this.simulateTxHistogram?.record(simResult.simTxDuration, {
				type: 'trigger',
				simError: simResult.simError !== null,
				...metricAttrFromUserAccount(
					driftUser.userAccountPublicKey,
					driftUser.getUserAccount()
				),
			});
			this.estTxCuHistogram?.record(simResult.cuEstimate, {
				type: 'trigger',
				simError: simResult.simError !== null,
				...metricAttrFromUserAccount(
					driftUser.userAccountPublicKey,
					driftUser.getUserAccount()
				),
			});

			if (this.simulateTxForCUEstimate && simResult.simError) {
				handleSimResultError(
					simResult,
					errorCodesToSuppress,
					`${this.name}: (executeTriggerableSpotNodesForMarket)`
				);
				logger.error(
					`executeTriggerableSpotNodesForMarket simError: (simError: ${JSON.stringify(
						simResult.simError
					)})`
				);
			} else {
				if (!this.dryRun) {
					if (this.hasEnoughSolToFill) {
						const txSigners = [this.driftClient.wallet.payer];

						// @ts-ignore;
						simResult.tx.sign(txSigners);
						const txSig = bs58.encode(simResult.tx.signatures[0]);
						this.registerTxSigToConfirm(
							txSig,
							Date.now(),
							undefined,
							-1,
							'trigger'
						);
						if (buildForBundle) {
							await this.sendTxThroughJito(simResult.tx, 'triggerOrder', txSig);
							this.removeTriggeringNodes(nodeToTrigger);
						} else if (this.canSendOutsideJito()) {
							this.driftClient
								.sendTransaction(simResult.tx)
								.then((txSig) => {
									logger.info(
										`Triggered user (account: ${nodeToTrigger.node.userAccount.toString()}, userSlot: ${
											user.slot
										}) order: ${nodeToTrigger.node.order.orderId.toString()}`
									);
									logger.info(`Tx: ${txSig}`);
								})
								.catch((error) => {
									nodeToTrigger.node.haveTrigger = false;

									const errorCode = getErrorCode(error);
									if (
										errorCode &&
										!errorCodesToSuppress.includes(errorCode) &&
										!(error as Error).message.includes(
											'Transaction was not confirmed'
										)
									) {
										const user = this.driftClient.getUser();
										this.txSimErrorCounter?.add(1, {
											errorCode: errorCode.toString(),
											...metricAttrFromUserAccount(
												user.userAccountPublicKey,
												user.getUserAccount()
											),
										});
										logger.error(
											`Error(${errorCode}) triggering order for user(account: ${nodeToTrigger.node.userAccount.toString()}) order: ${nodeToTrigger.node.order.orderId.toString()} `
										);
										logger.error(error);
										webhookMessage(
											`[${
												this.name
											}]: Error(${errorCode}) triggering order for user(account: ${nodeToTrigger.node.userAccount.toString()}) order: ${nodeToTrigger.node.order.orderId.toString()} \n${
												error.stack ? error.stack : error.message
											} `
										);
									}
								})
								.finally(() => {
									this.removeTriggeringNodes(nodeToTrigger);
								});
						}
					} else {
						logger.info(`Not enough SOL to fill, not triggering node`);
					}
				} else {
					logger.info(`dry run, not triggering node`);
				}
			}
		}

		const user = this.driftClient.getUser();
		this.attemptedTriggersCounter?.add(
			triggerableNodes.length,
			metricAttrFromUserAccount(
				user.userAccountPublicKey,
				user.getUserAccount()
			)
		);
	}

	private async trySpotFill() {
		const startTime = Date.now();
		let ran = false;

		try {
			// Check hasEnoughSolToFill before trying to fill, we do not want to fill if we don't have enough SOL
			if (!this.hasEnoughSolToFill) {
				logger.info(`Not enough SOL to fill, skipping periodic action`);
				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
				return;
			}

			await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
				const user = this.driftClient.getUser();
				this.lastTryFillTimeGauge?.setLatestValue(
					Date.now(),
					metricAttrFromUserAccount(
						user.getUserAccountPublicKey(),
						user.getUserAccount()
					)
				);
				const dlob = this.dlobSubscriber!.getDLOB();

				this.pruneThrottledNode();

				// 1) get all fillable nodes
				const fillableNodes: Array<NodesToFillWithContext> = [];
				let triggerableNodes: Array<NodeToTrigger> = [];
				for (const market of this.driftClient.getSpotMarketAccounts()) {
					if (market.marketIndex === 0) {
						continue;
					}

					const { nodesToFill, nodesToTrigger } = this.getSpotNodesForMarket(
						market,
						dlob
					);
					fillableNodes.push(nodesToFill);
					triggerableNodes = triggerableNodes.concat(nodesToTrigger);
				}
				logger.debug(`spot fillableNodes ${fillableNodes.length}`);

				// filter out nodes that we know cannot be triggered (spot nodes will be filtered in executeFillableSpotNodesForMarket)
				const filteredTriggerableNodes = triggerableNodes.filter(
					this.filterTriggerableNodes.bind(this)
				);
				logger.debug(
					`filtered triggerable nodes from ${triggerableNodes.length} to ${filteredTriggerableNodes.length} `
				);

				const buildForBundle = this.shouldBuildForBundle();

				await Promise.all([
					this.executeFillableSpotNodesForMarket(fillableNodes, buildForBundle),
					this.executeTriggerableSpotNodesForMarket(
						filteredTriggerableNodes,
						buildForBundle
					),
				]);

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
				logger.error('some other error:');
				console.error(e);
				if (e instanceof Error) {
					webhookMessage(
						`[${this.name}]: error trying to run main loop: \n${
							e.stack ? e.stack : e.message
						} `
					);
				}
			}
		} finally {
			this.clockSubscriberTs?.setLatestValue(
				this.clockSubscriber.getUnixTs(),
				{}
			);
			this.wallClockTs?.setLatestValue(Date.now() / 1000, {});

			if (ran) {
				const duration = Date.now() - startTime;
				const user = this.driftClient.getUser();
				if (this.tryFillDurationHistogram) {
					this.tryFillDurationHistogram!.record(
						duration,
						metricAttrFromUserAccount(
							user.getUserAccountPublicKey(),
							user.getUserAccount()
						)
					);
				}
				logger.debug(`trySpotFill done, took ${duration} ms`);
				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
			}
		}
	}

	protected async rebalanceSpotFiller() {
		logger.info(`Rebalancing filler`);
		const fillerSolBalance = await this.driftClient.connection.getBalance(
			this.driftClient.authority
		);
		this.hasEnoughSolToFill = fillerSolBalance >= this.minGasBalanceToFill;

		const fillerDriftAccountUsdcBalance = this.driftClient.getTokenAmount(0);
		const usdcSpotMarket = this.driftClient.getSpotMarketAccount(0);
		const normalizedFillerDriftAccountUsdcBalance =
			fillerDriftAccountUsdcBalance.divn(10 ** usdcSpotMarket!.decimals);
		const isUsdcAmountRebalanceable =
			normalizedFillerDriftAccountUsdcBalance.gte(
				this.rebalanceSettledPnlThreshold
			) || !this.hasEnoughSolToFill;

		logger.info(
			`SpotFiller has ${normalizedFillerDriftAccountUsdcBalance.toNumber()} USDC`
		);

		if (isUsdcAmountRebalanceable) {
			if (this.jupiterClient !== undefined) {
				logger.info(`Swapping USDC for SOL to rebalance filler`);
				swapFillerHardEarnedUSDCForSOL(
					this.priorityFeeSubscriber,
					this.driftClient,
					this.jupiterClient,
					await this.getBlockhashForTx()
				).then(async () => {
					const fillerSolBalanceAfterSwap =
						await this.driftClient.connection.getBalance(
							this.driftClient.authority,
							'processed'
						);
					this.hasEnoughSolToFill =
						fillerSolBalanceAfterSwap >= this.minGasBalanceToFill;
				});
			} else {
				throw new Error(
					'Jupiter client not initialized but trying to rebalance'
				);
			}
		}
	}
}
