import {
	ReferrerInfo,
	DriftClient,
	PerpMarketAccount,
	calculateAskPrice,
	calculateBidPrice,
	MakerInfo,
	calculateBaseAssetAmountForAmmToFulfill,
	isVariant,
	DLOB,
	NodeToFill,
	UserMap,
	UserStatsMap,
	MarketType,
	isOrderExpired,
	BulkAccountLoader,
	SlotSubscriber,
	PublicKey,
	DLOBNode,
	UserSubscriptionConfig,
	isOneOfVariant,
	DLOBSubscriber,
	NodeToTrigger,
	UserAccount,
	getUserAccountPublicKey,
	PriorityFeeSubscriber,
	DataAndSlot,
	BlockhashSubscriber,
	JupiterClient,
	BN,
	QUOTE_PRECISION,
	ClockSubscriber,
	StateAccount,
	getUserStatsAccountPublicKey,
	PositionDirection,
	PerpMarkets,
	MMOraclePriceData,
} from '@drift-labs/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';

import {
	TransactionInstruction,
	ComputeBudgetProgram,
	AddressLookupTableAccount,
	Connection,
	VersionedTransaction,
	LAMPORTS_PER_SOL,
	PACKET_DATA_SIZE,
} from '@solana/web3.js';

import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	View,
} from '@opentelemetry/sdk-metrics-base';

import { logger } from '../logger';
import { Bot } from '../types';
import { FillerConfig, GlobalConfig } from '../config';
import {
	CounterValue,
	GaugeValue,
	HistogramValue,
	RuntimeSpec,
	metricAttrFromUserAccount,
} from '../metrics';
import { webhookMessage } from '../webhook';
import {
	isEndIxLog,
	isErrFillingLog,
	isErrStaleOracle,
	isFillIxLog,
	isIxLog,
	isMakerBreachedMaintenanceMarginLog,
	isOrderDoesNotExistLog,
	isTakerBreachedMaintenanceMarginLog,
} from './common/txLogParse';
import { getErrorCode } from '../error';
import {
	SimulateAndGetTxWithCUsResponse,
	chunks,
	getAllPythOracleUpdateIxs,
	getFillSignatureFromUserAccountAndOrderId,
	getNodeToFillSignature,
	getNodeToTriggerSignature,
	getSizeOfTransaction,
	handleSimResultError,
	logMessageForNodeToFill,
	removePythIxs,
	simulateAndGetTxWithCUs,
	swapFillerHardEarnedUSDCForSOL,
	validMinimumGasAmount,
	validRebalanceSettledPnlThreshold,
	isFillableByVAMMDetails,
} from '../utils';
import { selectMakers } from '../makerSelection';
import { BundleSender, JITO_METRIC_TYPES } from '../bundleSender';
import { Metrics } from '../metrics';
import { LRUCache } from 'lru-cache';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import { TxThreaded } from './common/txThreaded';
import { NodeToTriggerWithMakers } from '../experimental-bots/filler-common/types';
import { PythLazerSubscriber } from '@drift-labs/sdk';

const TX_COUNT_COOLDOWN_ON_BURST = 10; // send this many tx before resetting burst mode
const FILL_ORDER_THROTTLE_BACKOFF = 1000; // the time to wait before trying to fill a throttled (error filling) node again
const THROTTLED_NODE_SIZE_TO_PRUNE = 10; // Size of throttled nodes to get to before pruning the map
const TRIGGER_ORDER_COOLDOWN_MS = 1000; // the time to wait before trying to a node in the triggering map again
export const MAX_MAKERS_PER_FILL = 6; // max number of unique makers to include per fill
const MAX_ACCOUNTS_PER_TX = 64; // solana limit, track https://github.com/solana-labs/solana/issues/27241

const MAX_POSITIONS_PER_USER = 8;
export const SETTLE_POSITIVE_PNL_COOLDOWN_MS = 60_000;
export const CONFIRM_TX_INTERVAL_MS = 5_000;
const SIM_CU_ESTIMATE_MULTIPLIER = 1.15;
const SLOTS_UNTIL_JITO_LEADER_TO_SEND = 4;
export const TX_CONFIRMATION_BATCH_SIZE = 100;
export const TX_TIMEOUT_THRESHOLD_MS = 60_000; // tx considered stale after this time and give up confirming
export const CONFIRM_TX_RATE_LIMIT_BACKOFF_MS = 5_000; // wait this long until trying to confirm tx again if rate limited
export const CACHED_BLOCKHASH_OFFSET = 5;
const DUMP_TXS_IN_SIM = false;

const EXPIRE_ORDER_BUFFER_SEC = 60; // add extra time before trying to expire orders (want to avoid 6252 error due to clock drift)
const NUM_MAKERS = 3; // number of makers to pull for triggerable orders

const errorCodesToSuppress = [
	6004, // 0x1774 Error Number: 6004. Error Message: SufficientCollateral.
	6010, // 0x177a Error Number: 6010. Error Message: User Has No Position In Market.
	6081, // 0x17c1 Error Number: 6081. Error Message: MarketWrongMutability.
	// 6078, // 0x17BE Error Number: 6078. Error Message: PerpMarketNotFound
	// 6087, // 0x17c7 Error Number: 6087. Error Message: SpotMarketNotFound.
	6239, // 0x185F Error Number: 6239. Error Message: RevertFill.
	6003, // 0x1773 Error Number: 6003. Error Message: Insufficient collateral.
	6023, // 0x1787 Error Number: 6023. Error Message: PriceBandsBreached.

	6111, // Error Message: OrderNotTriggerable.
	6112, // Error Message: OrderDidNotSatisfyTriggerCondition.
	6036, // Error Message: OracleNotFound.

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
	estimated_tx_cu_histogram = 'estimated_tx_cu_histogram',
	simulate_tx_duration_histogram = 'simulate_tx_duration_histogram',
	expired_nodes_set_size = 'expired_nodes_set_size',

	clock_subscriber_ts = 'clock_subscriber_ts',
	wall_clock_ts = 'wall_clock_ts',
}

export type MakerNodeMap = Map<string, DLOBNode[]>;
export type TxType = 'fill' | 'trigger' | 'settlePnl';

export class FillerBot extends TxThreaded implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 6000;

	protected slotSubscriber: SlotSubscriber;
	protected clockSubscriber: ClockSubscriber;
	protected bulkAccountLoader?: BulkAccountLoader;
	protected userStatsMapSubscriptionConfig: UserSubscriptionConfig;
	protected driftClient: DriftClient;
	/// Connection to use specifically for confirming transactions
	protected txConfirmationConnection: Connection;
	protected pollingIntervalMs: number;
	protected revertOnFailure?: boolean;
	protected simulateTxForCUEstimate?: boolean;
	protected lutAccounts: AddressLookupTableAccount[];
	protected lutKeys: string[] = [];
	protected bundleSender?: BundleSender;

	private fillerConfig: FillerConfig;
	private globalConfig: GlobalConfig;
	private dlobSubscriber?: DLOBSubscriber;
	private signerPubkey: string;

	private userMap?: UserMap;
	protected userStatsMap?: UserStatsMap;

	protected periodicTaskMutex = new Mutex();

	protected watchdogTimerMutex = new Mutex();
	protected watchdogTimerLastPatTime = Date.now();

	protected intervalIds: Array<NodeJS.Timer> = [];
	protected throttledNodes = new Map<string, number>();
	protected fillingNodes = new Map<string, number>();
	protected triggeringNodes = new Map<string, number>();

	protected useBurstCULimit = false;
	protected fillTxSinceBurstCU = 0;
	protected fillTxId = 0;
	protected lastSettlePnl = Date.now() - SETTLE_POSITIVE_PNL_COOLDOWN_MS;

	protected priorityFeeSubscriber: PriorityFeeSubscriber;
	protected blockhashSubscriber: BlockhashSubscriber;
	protected expiredNodesSet: LRUCache<string, boolean>;
	protected confirmLoopRunning = false;
	protected confirmLoopRateLimitTs =
		Date.now() - CONFIRM_TX_RATE_LIMIT_BACKOFF_MS;

	protected jupiterClient?: JupiterClient;

	// metrics
	protected metricsInitialized = false;
	protected metricsPort?: number;
	protected metrics?: Metrics;
	protected bootTimeMs?: number;

	protected runtimeSpec: RuntimeSpec;
	protected runtimeSpecsGauge?: GaugeValue;
	protected tryFillDurationHistogram?: HistogramValue;
	protected estTxCuHistogram?: HistogramValue;
	protected simulateTxHistogram?: HistogramValue;
	protected lastTryFillTimeGauge?: GaugeValue;
	protected mutexBusyCounter?: CounterValue;
	protected attemptedTriggersCounter?: CounterValue;
	protected txSimErrorCounter?: CounterValue;
	protected jitoConnectedGauge?: GaugeValue;
	protected jitoBundlesAcceptedGauge?: GaugeValue;
	protected jitoBundlesSimulationFailureGauge?: GaugeValue;
	protected jitoDroppedBundleGauge?: GaugeValue;
	protected jitoLandedTipsGauge?: GaugeValue;
	protected jitoBundleCount?: GaugeValue;
	protected clockSubscriberTs?: GaugeValue;
	protected wallClockTs?: GaugeValue;

	protected hasEnoughSolToFill: boolean = false;
	protected rebalanceFiller: boolean;
	protected minGasBalanceToFill: number;
	protected rebalanceSettledPnlThreshold: BN;

	pythLazerSubscriber?: PythLazerSubscriber;

	constructor(
		slotSubscriber: SlotSubscriber,
		bulkAccountLoader: BulkAccountLoader | undefined,
		driftClient: DriftClient,
		userMap: UserMap | undefined,
		runtimeSpec: RuntimeSpec,
		globalConfig: GlobalConfig,
		fillerConfig: FillerConfig,
		priorityFeeSubscriber: PriorityFeeSubscriber,
		blockhashSubscriber: BlockhashSubscriber,
		bundleSender?: BundleSender,
		lookupTableAccounts: AddressLookupTableAccount[] = []
	) {
		super();
		this.globalConfig = globalConfig;
		this.fillerConfig = fillerConfig;
		this.name = this.fillerConfig.botId;
		this.dryRun = this.fillerConfig.dryRun;
		this.slotSubscriber = slotSubscriber;
		this.driftClient = driftClient;

		if (globalConfig.txConfirmationEndpoint) {
			this.txConfirmationConnection = new Connection(
				globalConfig.txConfirmationEndpoint
			);
		} else {
			this.txConfirmationConnection = this.driftClient.connection;
		}
		this.bulkAccountLoader = bulkAccountLoader;
		if (this.bulkAccountLoader) {
			this.userStatsMapSubscriptionConfig = {
				type: 'polling',
				accountLoader: new BulkAccountLoader(
					this.bulkAccountLoader.connection,
					this.bulkAccountLoader.commitment,
					0 // no polling
				),
			};
		} else {
			this.userStatsMapSubscriptionConfig =
				this.driftClient.userAccountSubscriptionConfig;
		}
		this.runtimeSpec = runtimeSpec;
		this.pollingIntervalMs =
			this.fillerConfig.fillerPollingInterval ?? this.defaultIntervalMs;

		this.initializeMetrics(
			this.fillerConfig.metricsPort ?? this.globalConfig.metricsPort
		);
		this.userMap = userMap;

		this.revertOnFailure = this.fillerConfig.revertOnFailure ?? true;
		this.simulateTxForCUEstimate =
			this.fillerConfig.simulateTxForCUEstimate ?? true;
		logger.info(
			`${this.name}: revertOnFailure: ${this.revertOnFailure}, simulateTxForCUEstimate: ${this.simulateTxForCUEstimate}`
		);

		this.bundleSender = bundleSender;
		logger.info(
			`${this.name}: jito enabled: ${this.bundleSender !== undefined}`
		);

		this.lutAccounts = lookupTableAccounts;

		if (
			this.fillerConfig.rebalanceFiller &&
			this.runtimeSpec.driftEnv === 'mainnet-beta'
		) {
			this.jupiterClient = new JupiterClient({
				connection: this.driftClient.connection,
			});
		}

		this.rebalanceFiller = this.fillerConfig.rebalanceFiller ?? false;
		logger.info(
			`${this.name}: rebalancing enabled: ${this.jupiterClient !== undefined}`
		);

		if (!validMinimumGasAmount(this.fillerConfig.minGasBalanceToFill)) {
			this.minGasBalanceToFill = 0.2 * LAMPORTS_PER_SOL;
		} else {
			this.minGasBalanceToFill =
				this.fillerConfig.minGasBalanceToFill! * LAMPORTS_PER_SOL;
		}

		if (
			!validRebalanceSettledPnlThreshold(
				this.fillerConfig.rebalanceSettledPnlThreshold
			)
		) {
			this.rebalanceSettledPnlThreshold = new BN(20);
		} else {
			this.rebalanceSettledPnlThreshold = new BN(
				this.fillerConfig.rebalanceSettledPnlThreshold!
			);
		}

		logger.info(
			`${this.name}: minimumAmountToFill: ${this.minGasBalanceToFill}`
		);

		logger.info(
			`${this.name}: minimumAmountToSettle: ${this.rebalanceSettledPnlThreshold}`
		);

		this.priorityFeeSubscriber = priorityFeeSubscriber;
		this.blockhashSubscriber = blockhashSubscriber;

		this.expiredNodesSet = new LRUCache<string, boolean>({
			max: 10_000,
			ttl: TX_TIMEOUT_THRESHOLD_MS,
			ttlResolution: 1000,
		});
		this.clockSubscriber = new ClockSubscriber(driftClient.connection, {
			commitment: 'finalized',
			resubTimeoutMs: 5_000,
		});

		this.signerPubkey = this.driftClient.wallet.publicKey.toBase58();

		// Pyth lazer: remember to remove devnet guard
		if (this.globalConfig.driftEnv == 'devnet') {
			if (!this.globalConfig.lazerEndpoints || !this.globalConfig.lazerToken) {
				throw new Error('Missing lazerEndpoint or lazerToken in global config');
			}

			const markets = PerpMarkets[this.globalConfig.driftEnv!].filter(
				(market) =>
					market.pythLazerId !== undefined &&
					(!market.marketStatus ||
						!isOneOfVariant(market.marketStatus, ['delisted', 'settlement']))
			);
			const pythLazerIds = markets.map((m) => m.pythLazerId!);
			const pythLazerIdsChunks = chunks(pythLazerIds, 5);
			this.pythLazerSubscriber = new PythLazerSubscriber(
				this.globalConfig.lazerEndpoints,
				this.globalConfig.lazerToken,
				pythLazerIdsChunks.map((ids) => {
					return {
						priceFeedIds: ids,
						channel: 'fixed_rate@200ms',
					};
				}),
				this.globalConfig.driftEnv
			);
		}
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
		this.txSimErrorCounter = this.metrics.addCounter(
			METRIC_TYPES.tx_sim_error_count,
			'Count of errors from simulating transactions'
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

		this.initializeTxThreadMetrics(this.metrics, this.name);
		this.metrics!.finalizeObservables();
		this.runtimeSpecsGauge!.setLatestValue(this.bootTimeMs!, this.runtimeSpec);
		this.metricsInitialized = true;
	}

	protected async baseInit() {
		const fillerSolBalance = await this.driftClient.connection.getBalance(
			this.driftClient.authority
		);
		this.hasEnoughSolToFill = fillerSolBalance >= this.minGasBalanceToFill;
		logger.info(
			`${this.name}: hasEnoughSolToFill: ${this.hasEnoughSolToFill}, balance: ${fillerSolBalance}, cu boost: ${this.fillerConfig.triggerPriorityFeeMultiplier}`
		);

		const startInitUserStatsMap = Date.now();
		logger.info(`Initializing userStatsMap`);

		// sync userstats once
		const userStatsLoader = new BulkAccountLoader(
			new Connection(this.driftClient.connection.rpcEndpoint),
			'confirmed',
			0
		);
		this.userStatsMap = new UserStatsMap(this.driftClient, userStatsLoader);

		logger.info(
			`Initialized userStatsMap: ${this.userStatsMap.size()}, took: ${
				Date.now() - startInitUserStatsMap
			} ms`
		);

		await this.clockSubscriber.subscribe();
		await this.pythLazerSubscriber?.subscribe();

		this.lutAccounts.push(
			...(await this.driftClient.fetchAllLookupTableAccounts())
		);

		// initialize tx thread
		this.txThreadSetName(this.name);
		this.initTxThread(this.globalConfig.endpoint);
		this.sendSignerToTxThread(
			this.signerPubkey,
			this.globalConfig.keeperPrivateKey!
		);
		this.lutAccounts.forEach((account) => {
			this.sendAddressLutToTxThread(account.key.toBase58());
			this.lutKeys.push(account.key.toBase58());
		});
		this.setTxEnabledTxThread(!this.fillerConfig.dryRun);
	}

	public async init() {
		await this.baseInit();

		this.dlobSubscriber = new DLOBSubscriber({
			dlobSource: this.userMap!,
			slotSource: this.slotSubscriber,
			updateFrequency: this.pollingIntervalMs - 500,
			driftClient: this.driftClient,
		});
		await this.dlobSubscriber.subscribe();
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];

		await this.dlobSubscriber!.unsubscribe();
		await this.userMap!.unsubscribe();
	}

	public async startIntervalLoop(_intervalMs?: number) {
		this.intervalIds.push(
			setInterval(this.tryFill.bind(this), this.pollingIntervalMs)
		);
		this.intervalIds.push(
			setInterval(
				this.settlePnls.bind(this),
				SETTLE_POSITIVE_PNL_COOLDOWN_MS / 2
			)
		);
		if (this.bundleSender) {
			this.intervalIds.push(
				setInterval(this.recordJitoBundleStats.bind(this), 10_000)
			);
		}

		logger.info(
			`${this.name} Bot started! (websocket: ${
				this.bulkAccountLoader === undefined
			})`
		);
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
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 5 * this.pollingIntervalMs;
			if (!healthy) {
				logger.warn(
					`watchdog timer last pat time ${this.watchdogTimerLastPatTime} is too old`
				);
			}
		});

		return healthy;
	}

	protected async getUserAccountAndSlotFromMap(
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

	protected async getDLOB(): Promise<DLOB> {
		return this.dlobSubscriber!.getDLOB();
	}

	protected getMaxSlot(): number {
		return Math.max(this.slotSubscriber.getSlot(), this.userMap!.getSlot());
	}

	protected logSlots() {
		logger.info(
			`slotSubscriber slot: ${this.slotSubscriber.getSlot()}, userMap slot: ${this.userMap!.getSlot()}`
		);
	}

	protected getPerpNodesForMarket(
		market: PerpMarketAccount,
		dlob: DLOB
	): {
		nodesToFill: Array<NodeToFill>;
		nodesToTrigger: Array<NodeToTriggerWithMakers>;
	} {
		const marketIndex = market.marketIndex;

		const mmOraclePriceData =
			this.driftClient.getMMOracleDataForPerpMarket(marketIndex);

		const slot = new BN(this.slotSubscriber.getSlot());
		const vAsk = calculateAskPrice(
			market,
			mmOraclePriceData as MMOraclePriceData,
			slot
		);
		const vBid = calculateBidPrice(
			market,
			mmOraclePriceData as MMOraclePriceData,
			slot
		);

		const fillSlot = this.getMaxSlot();
		const nodesToTrigger = this.findTriggerableNodesWithMakers(
			dlob,
			marketIndex,
			fillSlot,
			mmOraclePriceData as MMOraclePriceData,
			MarketType.PERP,
			this.driftClient.getStateAccount()
		);

		return {
			nodesToFill: dlob.findNodesToFill(
				marketIndex,
				vBid,
				vAsk,
				fillSlot,
				this.clockSubscriber.getUnixTs() - EXPIRE_ORDER_BUFFER_SEC,
				MarketType.PERP,
				mmOraclePriceData as MMOraclePriceData,
				this.driftClient.getStateAccount(),
				this.driftClient.getPerpMarketAccount(marketIndex)!
			),
			nodesToTrigger,
		};
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

	protected clearThrottledNode(signature: string) {
		this.throttledNodes.delete(signature);
	}

	protected setThrottledNode(signature: string) {
		this.throttledNodes.set(signature, Date.now());
	}

	protected removeTriggeringNodes(node: NodeToTrigger) {
		this.triggeringNodes.delete(getNodeToTriggerSignature(node));
	}

	protected pruneThrottledNode() {
		if (this.throttledNodes.size > THROTTLED_NODE_SIZE_TO_PRUNE) {
			for (const [key, value] of this.throttledNodes.entries()) {
				if (value + 2 * FILL_ORDER_THROTTLE_BACKOFF > Date.now()) {
					this.throttledNodes.delete(key);
				}
			}
		}
	}

	protected filterFillableNodes(nodeToFill: NodeToFill): boolean {
		if (!nodeToFill.node.order) {
			return false;
		}

		if (nodeToFill.node.isVammNode()) {
			logger.warn(
				`filtered out a vAMM node on market ${nodeToFill.node.order.marketIndex} for user ${nodeToFill.node.userAccount}-${nodeToFill.node.order.orderId}`
			);
			return false;
		}

		if (nodeToFill.node.haveFilled) {
			logger.warn(
				`filtered out filled node on market ${nodeToFill.node.order.marketIndex} for user ${nodeToFill.node.userAccount}-${nodeToFill.node.order.orderId}`
			);
			return false;
		}

		const now = Date.now();
		const nodeToFillSignature = getNodeToFillSignature(nodeToFill);
		if (this.fillingNodes.has(nodeToFillSignature)) {
			const timeStartedToFillNode =
				this.fillingNodes.get(nodeToFillSignature) || 0;
			if (timeStartedToFillNode + FILL_ORDER_THROTTLE_BACKOFF > now) {
				// still cooling down on this node, filter it out
				return false;
			}
		}

		// expired orders that we previously tried to fill
		if (this.expiredNodesSet.has(nodeToFillSignature)) {
			return false;
		}

		// check if taker node is throttled
		if (this.isDLOBNodeThrottled(nodeToFill.node)) {
			return false;
		}

		const marketIndex = nodeToFill.node.order.marketIndex;
		const mmOraclePriceData =
			this.driftClient.getMMOracleDataForPerpMarket(marketIndex);

		if (isOrderExpired(nodeToFill.node.order, Date.now() / 1000, true)) {
			if (isOneOfVariant(nodeToFill.node.order.orderType, ['limit'])) {
				// do not try to fill (expire) limit orders b/c they will auto expire when filled against
				// or the user places a new order
				return false;
			}
			return true;
		}

		const isVammFillable = isFillableByVAMMDetails(
			nodeToFill.node.order,
			this.driftClient.getPerpMarketAccount(nodeToFill.node.order.marketIndex)!,
			mmOraclePriceData as MMOraclePriceData,
			this.getMaxSlot(),
			Date.now() / 1000,
			this.driftClient.getStateAccount()
		);

		if (
			nodeToFill.makerNodes.length === 0 &&
			isVariant(nodeToFill.node.order.marketType, 'perp') &&
			!isVammFillable.fillable
		) {
			logger.warn(
				`filtered out unfillable node on market ${nodeToFill.node.order.marketIndex} for user ${nodeToFill.node.userAccount}-${nodeToFill.node.order.orderId}`
			);
			logger.warn(` . no maker node: ${nodeToFill.makerNodes.length === 0}`);
			logger.warn(
				` . is perp: ${isVariant(nodeToFill.node.order.marketType, 'perp')}`
			);
			logger.warn(
				` . is not fillable by vamm: ${JSON.stringify(isVammFillable)}`
			);
			logger.warn(
				` .     calculateBaseAssetAmountForAmmToFulfill: ${calculateBaseAssetAmountForAmmToFulfill(
					nodeToFill.node.order,
					this.driftClient.getPerpMarketAccount(
						nodeToFill.node.order.marketIndex
					)!,
					mmOraclePriceData as MMOraclePriceData,
					this.getMaxSlot()
				).toString()}`
			);
			return false;
		}

		return true;
	}

	protected filterTriggerableNodes(nodeToTrigger: NodeToTrigger): boolean {
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

	protected async getNodeFillInfo(nodeToFill: NodeToFill): Promise<{
		makerInfos: Array<DataAndSlot<MakerInfo>>;
		takerUserPubKey: string;
		takerUser: UserAccount;
		takerUserSlot: number;
		referrerInfo: ReferrerInfo | undefined;
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

		const takerUserPubKey = nodeToFill.node.userAccount!.toString();
		const takerUserAcct = await this.getUserAccountAndSlotFromMap(
			takerUserPubKey
		);
		const referrerInfo = (
			await this.userStatsMap!.mustGet(takerUserAcct.data.authority.toString())
		).getReferrerInfo();

		return Promise.resolve({
			makerInfos,
			takerUserPubKey,
			takerUser: takerUserAcct.data,
			takerUserSlot: takerUserAcct.slot,
			referrerInfo,
			marketType: nodeToFill.node.order!.marketType,
		});
	}

	/**
	 * Iterates through a tx's logs and handles it appropriately (e.g. throttling users, updating metrics, etc.)
	 *
	 * @param nodesFilled nodes that we sent a transaction to fill
	 * @param logs logs from tx.meta.logMessages or this.clearingHouse.program._events._eventParser.parseLogs
	 * @returns number of nodes successfully filled, and whether the tx exceeded CUs
	 */
	protected async handleTransactionLogs(
		nodesFilled: Array<NodeToFill>,
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
		let ixIdx = -1; // skip ComputeBudgetProgram
		let successCount = 0;
		let burstedCU = false;
		for (const log of logs) {
			if (log === null) {
				logger.error(`log is null`);
				continue;
			}

			if (log.includes('exceeded maximum number of instructions allowed')) {
				// temporary burst CU limit
				logger.warn(`Using bursted CU limit`);
				this.useBurstCULimit = true;
				this.fillTxSinceBurstCU = 0;
				burstedCU = true;
				continue;
			}

			if (isEndIxLog(this.driftClient.program.programId.toBase58(), log)) {
				if (inFillIx && !errorThisFillIx) {
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
					ixIdx++;
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
				const filledNode = nodesFilled[ixIdx];
				if (filledNode) {
					const isExpired = isOrderExpired(
						filledNode.node.order!,
						Date.now() / 1000,
						true
					);
					logger.error(
						`assoc node (ixIdx: ${ixIdx}): ${filledNode.node.userAccount!.toString()}, ${
							filledNode.node.order!.orderId
						}; does not exist (filled by someone else); ${log}, expired: ${isExpired}, orderTs: ${
							filledNode.node.order!.maxTs
						}, now: ${Date.now() / 1000}`
					);
					if (isExpired) {
						const sig = getNodeToFillSignature(filledNode);
						this.expiredNodesSet.set(sig, true);
					}
				}
				errorThisFillIx = true;
				continue;
			}

			const makerBreachedMaintenanceMargin =
				isMakerBreachedMaintenanceMarginLog(log);
			if (makerBreachedMaintenanceMargin !== null) {
				logger.error(
					`Throttling maker breached maintenance margin: ${makerBreachedMaintenanceMargin}`
				);
				this.setThrottledNode(makerBreachedMaintenanceMargin);
				this.driftClient
					.forceCancelOrders(
						new PublicKey(makerBreachedMaintenanceMargin),
						(
							await this.getUserAccountAndSlotFromMap(
								makerBreachedMaintenanceMargin
							)
						).data
					)
					.then((txSig) => {
						logger.info(
							`Force cancelled orders for makers due to breach of maintenance margin. Tx: ${txSig}`
						);
					})
					.catch((e) => {
						console.error(e);
						logger.error(
							`Failed to send ForceCancelOrder Tx for maker (${makerBreachedMaintenanceMargin}) breach margin (error above):`
						);

						const errorCode = getErrorCode(e);

						if (
							errorCode &&
							!errorCodesToSuppress.includes(errorCode) &&
							!(e as Error).message.includes('Transaction was not confirmed')
						) {
							if (errorCode) {
								const user = this.driftClient.getUser();
								this.txSimErrorCounter?.add(1, {
									errorCode: errorCode.toString(),
									...metricAttrFromUserAccount(
										user.userAccountPublicKey,
										user.getUserAccount()
									),
								});
							}
							webhookMessage(
								`[${
									this.name
								}]: :x: error forceCancelling user ${makerBreachedMaintenanceMargin} for maker breaching margin tx logs:\n${
									e.stack ? e.stack : e.message
								}`
							);
						}
					});

				errorThisFillIx = true;
				break;
			}

			const takerBreachedMaintenanceMargin =
				isTakerBreachedMaintenanceMarginLog(log);
			if (takerBreachedMaintenanceMargin && nodesFilled[ixIdx]) {
				const filledNode = nodesFilled[ixIdx];
				const takerNodeSignature = filledNode.node.userAccount!;
				logger.error(
					`taker breach maint. margin, assoc node (ixIdx: ${ixIdx}): ${filledNode.node.userAccount!.toString()}, ${
						filledNode.node.order!.orderId
					}; (throttling ${takerNodeSignature} and force cancelling orders); ${log}`
				);
				this.setThrottledNode(takerNodeSignature);
				errorThisFillIx = true;

				this.driftClient
					.forceCancelOrders(
						new PublicKey(filledNode.node.userAccount!),
						(
							await this.getUserAccountAndSlotFromMap(
								filledNode.node.userAccount!.toString()
							)
						).data
					)
					.then((txSig) => {
						logger.info(
							`Force cancelled orders for user ${filledNode.node
								.userAccount!} due to breach of maintenance margin. Tx: ${txSig}`
						);
					})
					.catch((e) => {
						const userCanceling = filledNode.node.userAccount!.toString();
						console.error(e);
						logger.error(
							`Failed to send ForceCancelOrder Tx for taker (${userCanceling} - ${
								filledNode.node.order!.orderId
							}) breach maint. margin (error above):`
						);
						const errorCode = getErrorCode(e);
						if (
							errorCode &&
							!errorCodesToSuppress.includes(errorCode) &&
							!(e as Error).message.includes('Transaction was not confirmed')
						) {
							if (errorCode) {
								const user = this.driftClient.getUser();
								this.txSimErrorCounter?.add(1, {
									errorCode: errorCode.toString(),
									...metricAttrFromUserAccount(
										user.userAccountPublicKey,
										user.getUserAccount()
									),
								});
							}
							webhookMessage(
								`[${
									this.name
								}]: :x: error forceCancelling user ${userCanceling} for taker breaching maint. margin tx logs:\n${
									e.stack ? e.stack : e.message
								}`
							);
						}
					});

				continue;
			}

			const errFillingLog = isErrFillingLog(log);
			if (errFillingLog) {
				const orderId = errFillingLog[0];
				const userAcc = errFillingLog[1];
				const extractedSig = getFillSignatureFromUserAccountAndOrderId(
					userAcc,
					orderId
				);
				this.setThrottledNode(extractedSig);

				const filledNode = nodesFilled[ixIdx];
				const assocNodeSig = getNodeToFillSignature(filledNode);
				logger.warn(
					`Throttling node due to fill error. extractedSig: ${extractedSig}, assocNodeSig: ${assocNodeSig}, assocNodeIdx: ${ixIdx}`
				);
				errorThisFillIx = true;
				continue;
			}

			if (isErrStaleOracle(log)) {
				logger.error(`Stale oracle error: ${log}`);
				errorThisFillIx = true;
				continue;
			}
		}

		if (!burstedCU) {
			if (this.fillTxSinceBurstCU > TX_COUNT_COOLDOWN_ON_BURST) {
				this.useBurstCULimit = false;
			}
			this.fillTxSinceBurstCU += 1;
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

	protected removeFillingNodes(nodes: Array<NodeToFill>) {
		for (const node of nodes) {
			this.fillingNodes.delete(getNodeToFillSignature(node));
		}
	}

	protected async sendTxThroughJito(
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

	protected async sendFillTxAndParseLogs(
		fillTxId: number,
		tx: VersionedTransaction,
		buildForBundle: boolean,
		ixs?: Array<TransactionInstruction>
	) {
		if (buildForBundle) {
			tx.sign([
				// @ts-ignore;
				this.driftClient.wallet.payer,
			]);
			const txSig = bs58.encode(tx.signatures[0]);
			this.sendTxThroughJito(tx, fillTxId, txSig);
			this.registerTxToConfirm({ txSig });
		} else if (this.canSendOutsideJito()) {
			this.sendIxsToTxthread({
				ixs: ixs!,
				signerKeys: [this.signerPubkey],
				doSimulation: false,
				addressLookupTables: this.lutKeys,
			});
		}
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

	private async getPythIxsFromNode(
		node: NodeToFill | NodeToTrigger,
		precedingIxs: TransactionInstruction[] = []
	): Promise<TransactionInstruction[]> {
		const marketIndex = node.node.order?.marketIndex;
		if (marketIndex === undefined) {
			throw new Error('Market index not found on node');
		}
		if (
			isVariant(
				this.driftClient.getPerpMarketAccount(marketIndex)?.amm.oracleSource,
				'prelaunch'
			)
		) {
			// crankMarketIndex = getStaleOracleMarketIndexes(this.driftClient,
			// 	this.pullOraclePerpMarketWhitelist,
			// 	MarketType.PERP,
			// 	1
			// )[0];
			return [];
		}

		const pythIxs = await getAllPythOracleUpdateIxs(
			marketIndex,
			this.driftClient,
			this.pythLazerSubscriber,
			precedingIxs
		);
		return pythIxs;
	}

	/**
	 *
	 * @param fillTxId id of current fill
	 * @param nodeToFill taker node to fill with list of makers to use
	 * @returns true if successful, false if fail, and should retry with fewer makers
	 */
	private async fillMultiMakerPerpNodes(
		fillTxId: number,
		nodeToFill: NodeToFill,
		buildForBundle: boolean
	): Promise<boolean> {
		try {
			const {
				makerInfos,
				takerUser,
				takerUserPubKey,
				takerUserSlot,
				referrerInfo,
				marketType,
			} = await this.getNodeFillInfo(nodeToFill);

			logMessageForNodeToFill(
				nodeToFill,
				takerUserPubKey,
				takerUserSlot,
				makerInfos,
				this.getMaxSlot(),
				fillTxId,
				'multiMakerPerpFill',
				this.revertOnFailure ?? false,
				false
			);

			if (!isVariant(marketType, 'perp')) {
				throw new Error('expected perp market type');
			}

			const user = this.driftClient.getUser();
			let makerInfosToUse = makerInfos;
			const buildTxWithMakerInfos = async (
				makers: DataAndSlot<MakerInfo>[]
			): Promise<{
				ixs: Array<TransactionInstruction>;
				simResult: SimulateAndGetTxWithCUsResponse;
			}> => {
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
								this.priorityFeeSubscriber.getCustomStrategyResult() *
									this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()
							),
						})
					);
				}
				ixs.push(
					await this.driftClient.getFillPerpOrderIx(
						await getUserAccountPublicKey(
							this.driftClient.program.programId,
							takerUser.authority,
							takerUser.subAccountId
						),
						takerUser,
						nodeToFill.node.order!,
						makers.map((m) => m.data),
						referrerInfo
					)
				);

				this.fillingNodes.set(getNodeToFillSignature(nodeToFill), Date.now());

				if (this.revertOnFailure) {
					ixs.push(await this.driftClient.getRevertFillIx());
				}
				const simResult = await simulateAndGetTxWithCUs({
					ixs,
					connection: this.driftClient.connection,
					payerPublicKey: this.driftClient.wallet.publicKey,
					lookupTableAccounts: this.lutAccounts,
					cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
					doSimulation: this.simulateTxForCUEstimate,
					recentBlockhash: await this.getBlockhashForTx(),
					dumpTx: DUMP_TXS_IN_SIM,
					removeLastIxPostSim: this.revertOnFailure,
				});
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

				return { ixs, simResult };
			};

			let makerTx = await buildTxWithMakerInfos(makerInfosToUse);
			let txAccounts = makerTx.simResult.tx.message.getAccountKeys({
				addressLookupTableAccounts: this.lutAccounts,
			}).length;
			let attempt = 0;
			while (txAccounts > MAX_ACCOUNTS_PER_TX && makerInfosToUse.length > 0) {
				logger.info(
					`(fillTxId: ${fillTxId} attempt ${attempt++}) Too many accounts, remove 1 and try again (had ${
						makerInfosToUse.length
					} maker and ${txAccounts} accounts)`
				);
				makerInfosToUse = makerInfosToUse.slice(0, makerInfosToUse.length - 1);
				makerTx = await buildTxWithMakerInfos(makerInfosToUse);
				txAccounts = makerTx.simResult.tx.message.getAccountKeys({
					addressLookupTableAccounts: this.lutAccounts,
				}).length;
			}

			if (makerInfosToUse.length === 0) {
				logger.error(
					`No makerInfos left to use for multi maker perp node (fillTxId: ${fillTxId})`
				);
				return true;
			}

			if (makerTx.simResult.simError) {
				logger.error(
					`Error simulating multi maker perp node (fillTxId: ${fillTxId}): ${JSON.stringify(
						makerTx.simResult.simError
					)}\nTaker slot: ${takerUserSlot}\nMaker slots: ${makerInfosToUse
						.map((m) => `  ${m.data.maker.toBase58()}: ${m.slot}`)
						.join('\n')}`
				);
				handleSimResultError(
					makerTx.simResult,
					errorCodesToSuppress,
					`${this.name}: (fillTxId: ${fillTxId})`
				);
				if (makerTx.simResult.simTxLogs) {
					const { exceededCUs } = await this.handleTransactionLogs(
						[nodeToFill],
						makerTx.simResult.simTxLogs
					);
					if (exceededCUs) {
						return false;
					}
				}
			} else {
				if (this.dryRun) {
					logger.info(`dry run, not sending tx (fillTxId: ${fillTxId})`);
				} else {
					if (this.hasEnoughSolToFill) {
						this.sendFillTxAndParseLogs(
							fillTxId,
							makerTx.simResult.tx,
							buildForBundle,
							makerTx.ixs
						);
						this.removeFillingNodes([nodeToFill]);
					} else {
						logger.info(
							`not sending tx because we don't have enough SOL to fill (fillTxId: ${fillTxId})`
						);
					}
				}
			}
		} catch (e) {
			if (e instanceof Error) {
				logger.error(
					`Error filling multi maker perp node (fillTxId: ${fillTxId}): ${
						e.stack ? e.stack : e.message
					}`
				);
			}
		}
		return true;
	}

	/**
	 * It's difficult to estimate CU cost of multi maker ix, so we'll just send it in its own transaction
	 * @param nodeToFill node with multiple makers
	 */
	protected async tryFillMultiMakerPerpNode(
		nodeToFill: NodeToFill,
		buildForBundle: boolean
	) {
		const fillTxId = this.fillTxId++;

		let nodeWithMakerSet = nodeToFill;
		while (
			!(await this.fillMultiMakerPerpNodes(
				fillTxId,
				nodeWithMakerSet,
				buildForBundle
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
					`No makers left to use for multi maker perp node (fillTxId: ${fillTxId})`
				);
				return;
			}
		}
	}

	protected async tryFillPerpNodes(
		nodesToFill: Array<NodeToFill>,
		buildForBundle: boolean
	): Promise<number> {
		const nodesSent: Array<NodeToFill> = [];
		const fillTxId = this.fillTxId++;

		for (const [_idx, nodeToFill] of nodesToFill.entries()) {
			let ixs: Array<TransactionInstruction> = [
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
								this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()
						),
					})
				);
			}

			// do multi maker fills in a separate tx since they're larger
			if (nodeToFill.makerNodes.length > 2) {
				await this.tryFillMultiMakerPerpNode(nodeToFill, buildForBundle);
				nodesSent.push(nodeToFill);
				continue;
			}

			// otherwise pack fill ixs until est. tx size or CU limit is hit
			const {
				makerInfos,
				takerUser,
				takerUserPubKey,
				takerUserSlot,
				referrerInfo,
				marketType,
			} = await this.getNodeFillInfo(nodeToFill);

			logMessageForNodeToFill(
				nodeToFill,
				takerUserPubKey,
				takerUserSlot,
				makerInfos,
				this.getMaxSlot(),
				fillTxId,
				'fillPerpNode',
				this.revertOnFailure ?? false,
				false
			);
			this.logSlots();

			if (!isVariant(marketType, 'perp')) {
				throw new Error('expected perp market type');
			}

			let removeLastIxPostSim = this.revertOnFailure;
			if (
				this.pythLazerSubscriber &&
				((makerInfos.length == 2 && !referrerInfo) || makerInfos.length < 2)
			) {
				const pythIxs = await this.getPythIxsFromNode(nodeToFill, ixs);
				ixs.push(...pythIxs);
				removeLastIxPostSim = false;
			}

			const ix = await this.driftClient.getFillPerpOrderIx(
				await getUserAccountPublicKey(
					this.driftClient.program.programId,
					takerUser.authority,
					takerUser.subAccountId
				),
				takerUser,
				nodeToFill.node.order!,
				makerInfos.map((m) => m.data),
				referrerInfo
			);

			if (!ix) {
				logger.error(`failed to generate an ix`);
				break;
			}

			this.fillingNodes.set(getNodeToFillSignature(nodeToFill), Date.now());

			// add to tx
			logger.info(
				`including taker ${(
					await getUserAccountPublicKey(
						this.driftClient.program.programId,
						takerUser.authority,
						takerUser.subAccountId
					)
				).toString()}-${nodeToFill.node.order!.orderId.toString()} (slot: ${takerUserSlot}) (fillTxId: ${fillTxId}), maker: ${makerInfos
					.map((m) => `${m.data.maker.toBase58()}: ${m.slot}`)
					.join(', ')}`
			);
			ixs.push(ix);

			if (this.revertOnFailure) {
				ixs.push(await this.driftClient.getRevertFillIx());
			}

			const txSize = getSizeOfTransaction(ixs, true, this.lutAccounts).bytes;
			if (txSize > PACKET_DATA_SIZE) {
				logger.info(`tx too large, removing pyth ixs.
						keys: ${ixs.map((ix) => ix.keys.map((key) => key.pubkey.toString()))}
						total number of maker positions: ${makerInfos.reduce(
							(acc, maker) =>
								acc +
								(maker.data.makerUserAccount.perpPositions.length +
									maker.data.makerUserAccount.spotPositions.length),
							0
						)}
						total taker positions: ${
							takerUser.perpPositions.length + takerUser.spotPositions.length
						}
						marketIndex: ${nodeToFill.node.order!.marketIndex}
						taker has position in market: ${takerUser.perpPositions.some(
							(pos) => pos.marketIndex === nodeToFill.node.order!.marketIndex
						)}
						makers have position in market: ${makerInfos.some((maker) =>
							maker.data.makerUserAccount.perpPositions.some(
								(pos) => pos.marketIndex === nodeToFill.node.order!.marketIndex
							)
						)}
						`);
				ixs = removePythIxs(ixs);
			}

			let simResult;
			const user = this.driftClient.getUser();
			try {
				simResult = await simulateAndGetTxWithCUs({
					ixs,
					connection: this.driftClient.connection,
					payerPublicKey: this.driftClient.wallet.publicKey,
					lookupTableAccounts: this.lutAccounts,
					cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
					doSimulation: this.simulateTxForCUEstimate,
					recentBlockhash: await this.getBlockhashForTx(),
					dumpTx: DUMP_TXS_IN_SIM,
					removeLastIxPostSim,
				});
			} catch (e) {
				logger.error(
					`Error simulating fill perp nodes (fillTxId: ${fillTxId}): ${e}`
				);
				return nodesSent.length;
			}

			this.simulateTxHistogram?.record(simResult.simTxDuration, {
				type: 'fill',
				simError: simResult.simError !== null,
				...metricAttrFromUserAccount(
					user.userAccountPublicKey,
					user.getUserAccount()
				),
			});
			this.estTxCuHistogram?.record(simResult.cuEstimate, {
				type: 'fill',
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
					)} (fillTxId: ${fillTxId}), sim logs:\n${
						simResult.simTxLogs ? simResult.simTxLogs.join('\n') : 'none'
					}`
				);
				handleSimResultError(
					simResult,
					errorCodesToSuppress,
					`${this.name}: (fillTxId: ${fillTxId})`
				);
				if (simResult.simTxLogs) {
					await this.handleTransactionLogs(nodesToFill, simResult.simTxLogs);
				}
			} else {
				if (this.dryRun) {
					logger.info(`dry run, not sending tx (fillTxId: ${fillTxId})`);
				} else {
					if (this.hasEnoughSolToFill) {
						this.sendFillTxAndParseLogs(
							fillTxId,
							simResult.tx,
							buildForBundle,
							ixs
						);
						this.removeFillingNodes(nodesSent);
					} else {
						logger.info(
							`not sending tx because we don't have enough SOL to fill (fillTxId: ${fillTxId})`
						);
					}
				}
			}

			nodesSent.push(nodeToFill);
		}

		return nodesSent.length;
	}

	protected filterPerpNodesForMarket(
		fillableNodes: Array<NodeToFill>,
		triggerableNodes: Array<NodeToTriggerWithMakers>
	): {
		filteredFillableNodes: Array<NodeToFill>;
		filteredTriggerableNodes: Array<NodeToTriggerWithMakers>;
	} {
		const seenFillableNodes = new Set<string>();
		const filteredFillableNodes = fillableNodes.filter((node) => {
			const sig = getNodeToFillSignature(node);
			if (seenFillableNodes.has(sig)) {
				return false;
			}
			seenFillableNodes.add(sig);
			return this.filterFillableNodes(node);
		});

		const seenTriggerableNodes = new Set<string>();
		const filteredTriggerableNodes = triggerableNodes.filter((node) => {
			const sig = getNodeToTriggerSignature(node);
			if (seenTriggerableNodes.has(sig)) {
				return false;
			}
			seenTriggerableNodes.add(sig);
			return this.filterTriggerableNodes(node);
		});

		return {
			filteredFillableNodes,
			filteredTriggerableNodes,
		};
	}

	protected async executeFillablePerpNodesForMarket(
		fillableNodes: Array<NodeToFill>,
		buildForBundle: boolean
	) {
		await this.tryFillPerpNodes(fillableNodes, buildForBundle);
	}

	protected async executeTriggerablePerpNodesForMarket(
		triggerableNodes: Array<NodeToTriggerWithMakers>,
		buildForBundle: boolean
	) {
		for (const nodeToTrigger of triggerableNodes) {
			nodeToTrigger.node.haveTrigger = true;
			const user = await this.getUserAccountAndSlotFromMap(
				nodeToTrigger.node.userAccount.toString()
			);
			logger.info(
				`Processing node: account=${nodeToTrigger.node.userAccount.toString()}, slot=${
					user.slot
				}, orderId=${nodeToTrigger.node.order.orderId.toString()}, numMakers=${
					nodeToTrigger.makers?.length ?? 0
				}`
			);

			const nodeSignature = getNodeToTriggerSignature(nodeToTrigger);
			this.triggeringNodes.set(nodeSignature, Date.now());

			let ixs = [
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

			let removeLastIxPostSim = this.revertOnFailure;
			if (this.pythLazerSubscriber) {
				const pythIxs = await this.getPythIxsFromNode(nodeToTrigger, ixs);
				ixs.push(...pythIxs);
				removeLastIxPostSim = false;
			}

			ixs.push(
				await this.driftClient.getTriggerOrderIx(
					new PublicKey(nodeToTrigger.node.userAccount),
					user.data,
					nodeToTrigger.node.order
				)
			);

			logger.info(`Triggrable node has ${nodeToTrigger.makers.length} makers`);
			const makerInfos = await Promise.all(
				nodeToTrigger.makers.map(async (m) => {
					const maker = new PublicKey(m);
					logger.info(`Getting maker info for ${maker.toString()}`);
					const { data } = await this.getUserAccountAndSlotFromMap(
						maker.toString()
					);
					const makerUserAccount = data;
					const makerAuthority = makerUserAccount.authority;
					const makerStats = getUserStatsAccountPublicKey(
						this.driftClient.program.programId,
						makerAuthority
					);
					return {
						maker,
						makerStats,
						makerUserAccount,
					};
				})
			);
			let referrerInfo: ReferrerInfo | undefined;
			try {
				const takerUserPubKey = nodeToTrigger.node.userAccount.toString();
				const takerUserAcct = await this.getUserAccountAndSlotFromMap(
					takerUserPubKey
				);
				const userStats = await this.userStatsMap!.mustGet(
					takerUserAcct.data.authority.toString()
				);
				referrerInfo = userStats.getReferrerInfo();
				logger.info(
					`[Filler - executeTriggerablePerpNodes] Got referrerInfo: ${referrerInfo}`
				);
			} catch (e) {
				logger.warn(
					`[Filler - executeTriggerablePerpNodes] Failed to get referrer info: ${e}`
				);
				referrerInfo = undefined;
			}

			const driftUser = this.driftClient.getUser();

			const getSimResult = async (makerInfos: MakerInfo[]) => {
				const fillIx = await this.driftClient.getFillPerpOrderIx(
					new PublicKey(nodeToTrigger.node.userAccount),
					user.data,
					nodeToTrigger.node.order,
					makerInfos,
					referrerInfo
				);
				ixs.push(fillIx);

				if (this.revertOnFailure) {
					ixs.push(await this.driftClient.getRevertFillIx());
				}

				const txSize = getSizeOfTransaction(ixs, true, this.lutAccounts).bytes;
				if (txSize > PACKET_DATA_SIZE) {
					logger.info(
						`tx too large, removing pyth ixs. keys: ${ixs.map((ix) =>
							ix.keys.map((key) => key.pubkey.toString())
						)}`
					);
					ixs = removePythIxs(ixs);
				}
				const simResult = await simulateAndGetTxWithCUs({
					ixs,
					connection: this.driftClient.connection,
					payerPublicKey: this.driftClient.wallet.publicKey,
					lookupTableAccounts: this.lutAccounts,
					cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
					doSimulation: this.simulateTxForCUEstimate,
					recentBlockhash: await this.getBlockhashForTx(),
					dumpTx: DUMP_TXS_IN_SIM,
					removeLastIxPostSim,
				});
				return simResult;
			};

			let simResult;
			for (let i = NUM_MAKERS; i >= 0; i--) {
				simResult = await getSimResult(makerInfos.slice(0, i));
				if (simResult.simError) {
					logger.info(
						`[Filler - executeTriggerablePerpNodesForMarket] Sim error, attempted ${i} makers, error: ${JSON.stringify(
							simResult.simError
						)}, logs: ${JSON.stringify(simResult.simTxLogs)}`
					);
				} else {
					break;
				}
			}

			if (!simResult) {
				logger.error(
					`[Filler - executeTriggerablePerpNodesForMarket] No valid sim result`
				);
				continue;
			}

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
				logger.error(
					`executeTriggerablePerpNodesForMarket simError: (simError: ${JSON.stringify(
						simResult.simError
					)}, sim logs: ${JSON.stringify(simResult.simTxLogs)})`
				);
				handleSimResultError(
					simResult,
					errorCodesToSuppress,
					`${this.name}: (executeTriggerablePerpNodesForMarket)`
				);
			} else {
				if (!this.dryRun) {
					if (this.hasEnoughSolToFill) {
						if (buildForBundle) {
							simResult.tx.sign([
								// @ts-ignore;
								this.driftClient.wallet.payer,
							]);
							const txSig = bs58.encode(simResult.tx.signatures[0]);
							this.sendTxThroughJito(simResult.tx, 'triggerOrder', txSig);
							this.registerTxToConfirm({ txSig });
						} else if (this.canSendOutsideJito()) {
							this.sendIxsToTxthread({
								ixs,
								signerKeys: [this.signerPubkey],
								doSimulation: false,
								addressLookupTables: this.lutKeys,
							});
						}
						this.removeTriggeringNodes(nodeToTrigger);
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

	protected async settlePnls() {
		// Check if we have enough SOL to fill
		const fillerSolBalance = await this.driftClient.connection.getBalance(
			this.driftClient.authority
		);
		this.hasEnoughSolToFill = fillerSolBalance >= this.minGasBalanceToFill;

		const user = this.driftClient.getUser();
		const activePerpPositions = user.getActivePerpPositions().sort((a, b) => {
			return b.quoteAssetAmount.sub(a.quoteAssetAmount).toNumber();
		});
		const marketIds = activePerpPositions.map((pos) => pos.marketIndex);
		const totalUnsettledPnl = activePerpPositions.reduce(
			(totalUnsettledPnl, position) => {
				return totalUnsettledPnl.add(position.quoteAssetAmount);
			},
			new BN(0)
		);

		const now = Date.now();
		// Settle pnl if:
		// - we are rebalancing and have enough unsettled pnl to rebalance preemptively
		// - we are rebalancing and don't have enough SOL to fill
		// - we have hit max positions to free up slots
		if (
			(this.rebalanceFiller &&
				(totalUnsettledPnl.gte(
					this.rebalanceSettledPnlThreshold.mul(QUOTE_PRECISION)
				) ||
					!this.hasEnoughSolToFill)) ||
			marketIds.length === MAX_POSITIONS_PER_USER
		) {
			logger.info(
				`Settling positive PNLs for markets: ${JSON.stringify(marketIds)}`
			);
			if (now < this.lastSettlePnl + SETTLE_POSITIVE_PNL_COOLDOWN_MS) {
				logger.info(`Want to settle positive pnl, but in cooldown...`);
			} else {
				let chunk_size;
				if (marketIds.length < 5) {
					chunk_size = marketIds.length;
				} else {
					chunk_size = marketIds.length / 2;
				}
				for (let i = 0; i < marketIds.length; i += chunk_size) {
					const buildForBundle = this.shouldBuildForBundle();
					const marketIdChunks = marketIds.slice(i, i + chunk_size);
					try {
						const ixs = [
							ComputeBudgetProgram.setComputeUnitLimit({
								units: 1_400_000, // will be overridden by simulateTx
							}),
						];
						if (buildForBundle) {
							ixs.push(this.bundleSender!.getTipIx());
						} else {
							ixs.push(
								ComputeBudgetProgram.setComputeUnitPrice({
									microLamports: Math.floor(
										this.priorityFeeSubscriber.getCustomStrategyResult() *
											this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()
									),
								})
							);
						}
						ixs.push(
							...(await this.driftClient.getSettlePNLsIxs(
								[
									{
										settleeUserAccountPublicKey: user.getUserAccountPublicKey(),
										settleeUserAccount: this.driftClient.getUserAccount()!,
									},
								],
								marketIdChunks
							))
						);

						const simResult = await simulateAndGetTxWithCUs({
							ixs,
							connection: this.driftClient.connection,
							payerPublicKey: this.driftClient.wallet.publicKey,
							lookupTableAccounts: this.lutAccounts,
							cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
							doSimulation: this.simulateTxForCUEstimate,
							recentBlockhash: await this.getBlockhashForTx(),
							dumpTx: DUMP_TXS_IN_SIM,
						});
						this.simulateTxHistogram?.record(simResult.simTxDuration, {
							type: 'settlePnl',
							simError: simResult.simError !== null,
							...metricAttrFromUserAccount(
								user.userAccountPublicKey,
								user.getUserAccount()
							),
						});
						this.estTxCuHistogram?.record(simResult.cuEstimate, {
							type: 'settlePnl',
							simError: simResult.simError !== null,
							...metricAttrFromUserAccount(
								user.userAccountPublicKey,
								user.getUserAccount()
							),
						});

						if (this.simulateTxForCUEstimate && simResult.simError) {
							logger.info(
								`settlePnls simError: ${JSON.stringify(
									simResult.simError
								)}, sim logs:\n${
									simResult.simTxLogs ? simResult.simTxLogs.join('\n') : 'none'
								}`
							);
							handleSimResultError(
								simResult,
								errorCodesToSuppress,
								`${this.name}: (settlePnls)`
							);
						} else {
							if (!this.dryRun) {
								if (buildForBundle) {
									simResult.tx.sign([
										// @ts-ignore;
										this.driftClient.wallet.payer,
									]);
									const txSig = bs58.encode(simResult.tx.signatures[0]);
									this.sendTxThroughJito(simResult.tx, 'settlePnl', txSig);
									this.registerTxToConfirm({ txSig });
								} else if (this.canSendOutsideJito()) {
									this.sendIxsToTxthread({
										ixs,
										signerKeys: [this.signerPubkey],
										doSimulation: false,
										addressLookupTables: this.lutKeys,
									});
								}
							} else {
								logger.info(`dry run, skipping settlePnls)`);
							}
						}
					} catch (err) {
						if (!(err instanceof Error)) {
							return;
						}
						const errorCode = getErrorCode(err) ?? 0;
						logger.error(
							`Error code: ${errorCode} while settling pnls for markets ${JSON.stringify(
								marketIds
							)}: ${err.message}`
						);
						console.error(err);
					}
				}
				this.lastSettlePnl = now;
			}
		}

		// If we are rebalancing, check if we have enough settled pnl in usdc account to rebalance,
		// or if we have to go below threshold since we don't have enough sol
		if (this.rebalanceFiller) {
			const fillerDriftAccountUsdcBalance = this.driftClient.getTokenAmount(0);
			const usdcSpotMarket = this.driftClient.getSpotMarketAccount(0);
			const normalizedFillerDriftAccountUsdcBalance =
				fillerDriftAccountUsdcBalance.divn(10 ** usdcSpotMarket!.decimals);

			if (
				normalizedFillerDriftAccountUsdcBalance.gte(
					this.rebalanceSettledPnlThreshold
				) ||
				!this.hasEnoughSolToFill
			) {
				logger.info(
					`Filler has ${normalizedFillerDriftAccountUsdcBalance.toNumber()} usdc to rebalance`
				);
				await this.rebalance();
			}
		}
	}

	protected async rebalance() {
		logger.info(`Rebalancing filler`);
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
			throw new Error('Jupiter client not initialized but trying to rebalance');
		}
	}

	protected usingJito(): boolean {
		return this.bundleSender !== undefined;
	}

	protected canSendOutsideJito(): boolean {
		return (
			!this.usingJito() ||
			this.bundleSender?.strategy === 'non-jito-only' ||
			this.bundleSender?.strategy === 'hybrid'
		);
	}

	protected slotsUntilJitoLeader(): number | undefined {
		if (!this.usingJito()) {
			return undefined;
		}
		return this.bundleSender?.slotsUntilNextLeader();
	}

	protected shouldBuildForBundle(): boolean {
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

	public findTriggerableNodesWithMakers(
		dlob: DLOB,
		marketIndex: number,
		slot: number,
		mmOraclePriceData: MMOraclePriceData,
		marketType: MarketType,
		stateAccount: StateAccount
	): NodeToTriggerWithMakers[] {
		const baseTriggerable = dlob.findNodesToTrigger(
			marketIndex,
			slot,
			mmOraclePriceData.price,
			marketType,
			stateAccount
		);
		if (baseTriggerable.length > 0) {
			logger.info(
				`Found ${baseTriggerable.length} nodes to trigger for market ${marketIndex}`
			);
		}

		const triggerWithMaker: NodeToTriggerWithMakers[] = [];

		for (const nodeObj of baseTriggerable) {
			const order = nodeObj.node.order;

			const makers = dlob.getBestMakers({
				marketIndex,
				marketType,
				direction: isVariant(order.direction, 'long')
					? PositionDirection.SHORT
					: PositionDirection.LONG,
				slot,
				oraclePriceData: mmOraclePriceData,
				numMakers: NUM_MAKERS,
			});
			triggerWithMaker.push({
				...nodeObj,
				makers,
			});
		}

		return triggerWithMaker;
	}

	protected async tryFill() {
		const startTime = Date.now();
		let ran = false;

		try {
			// Check hasEnoughSolToFill before trying to fill, we do not want to fill if we don't have enough SOL
			if (!this.hasEnoughSolToFill) {
				logger.info(`Not enough SOL to fill, skipping fill`);
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

				const dlob = await this.getDLOB();
				this.pruneThrottledNode();

				// 1) get all fillable nodes
				let fillableNodes: Array<NodeToFill> = [];
				let triggerableNodes: Array<NodeToTriggerWithMakers> = [];
				for (const market of this.driftClient.getPerpMarketAccounts()) {
					try {
						const { nodesToFill, nodesToTrigger } = this.getPerpNodesForMarket(
							market,
							dlob
						);
						fillableNodes = fillableNodes.concat(nodesToFill);
						triggerableNodes = triggerableNodes.concat(nodesToTrigger);
					} catch (e) {
						if (e instanceof Error) {
							console.error(e);
							webhookMessage(
								`[${this.name}]: :x: Failed to get fillable nodes for market ${
									market.marketIndex
								}:\n${e.stack ? e.stack : e.message}`
							);
						}
						continue;
					}
				}

				// filter out nodes that we know cannot be filled
				const { filteredFillableNodes, filteredTriggerableNodes } =
					this.filterPerpNodesForMarket(fillableNodes, triggerableNodes);
				logger.debug(
					`filtered fillable nodes from ${fillableNodes.length} to ${filteredFillableNodes.length}, filtered triggerable nodes from ${triggerableNodes.length} to ${filteredTriggerableNodes.length}`
				);

				const buildForBundle = this.shouldBuildForBundle();

				// fill the perp nodes
				await Promise.all([
					this.executeFillablePerpNodesForMarket(
						filteredFillableNodes,
						buildForBundle
					),
					this.executeTriggerablePerpNodesForMarket(
						filteredTriggerableNodes,
						buildForBundle
					),
				]);

				// check if should settle positive pnl
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
				if (e instanceof Error) {
					webhookMessage(
						`[${this.name}]: :x: uncaught error:\n${
							e.stack ? e.stack : e.message
						}`
					);
				}
				throw e;
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
				this.tryFillDurationHistogram?.record(
					duration,
					metricAttrFromUserAccount(
						user.getUserAccountPublicKey(),
						user.getUserAccount()
					)
				);
				logger.debug(`tryFill done, took ${duration}ms`);
				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
			}
		}
	}
}
