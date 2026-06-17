/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
	DriftClient,
	BlockhashSubscriber,
	UserStatsMap,
	NodeToFill,
	JupiterClient,
	BulkAccountLoader,
	isVariant,
	DLOBNode,
	BN,
	PhoenixV1FulfillmentConfigAccount,
	TEN,
	SlotSubscriber,
	DataAndSlot,
	MakerInfo,
	MarketType,
	UserAccount,
	decodeUser,
	PriorityFeeSubscriberMap,
	OpenbookV2FulfillmentConfigAccount,
} from '@drift-labs/sdk';
import {
	Connection,
	AddressLookupTableAccount,
	LAMPORTS_PER_SOL,
	PublicKey,
	SendTransactionError,
	VersionedTransaction,
	TransactionSignature,
	VersionedTransactionResponse,
	ComputeBudgetProgram,
	TransactionInstruction,
} from '@solana/web3.js';
import { LRUCache } from 'lru-cache';
import { FillerMultiThreadedConfig, GlobalConfig } from '../../config';
import { BundleSender, JITO_METRIC_TYPES } from '../../bundleSender';
import { logger } from '../../logger';
import {
	CounterValue,
	GaugeValue,
	HistogramValue,
	metricAttrFromUserAccount,
	Metrics,
	RuntimeSpec,
} from '../../metrics';
import {
	MEMO_PROGRAM_ID,
	SimulateAndGetTxWithCUsResponse,
	getFillSignatureFromUserAccountAndOrderId,
	getNodeToFillSignature,
	getTransactionAccountMetas,
	handleSimResultError,
	initializeSpotFulfillmentAccounts,
	logMessageForNodeToFill,
	simulateAndGetTxWithCUs,
	sleepMs,
	swapFillerHardEarnedUSDCForSOL,
	validMinimumGasAmount,
} from '../../utils';
import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	View,
} from '@opentelemetry/sdk-metrics-base';
import { ChildProcess } from 'child_process';
import {
	deserializeNodeToFill,
	serializeNodeToFill,
	spawnChild,
	isTsRuntime,
} from '../filler-common/utils';
import {
	CACHED_BLOCKHASH_OFFSET,
	MAX_MAKERS_PER_FILL,
	MakerNodeMap,
	TX_CONFIRMATION_BATCH_SIZE,
} from '../filler/fillerMultithreaded';
import {
	NodeToFillWithBuffer,
	SerializedNodeToFill,
} from '../filler-common/types';
import {
	isEndIxLog,
	isFillIxLog,
	isIxLog,
	isMakerBreachedMaintenanceMarginLog,
	isOrderDoesNotExistLog,
	isTakerBreachedMaintenanceMarginLog,
} from '../../bots/common/txLogParse';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import { getErrorCode } from '../../error';
import { webhookMessage } from '../../webhook';
import { selectMakers } from '../../makerSelection';
import path from 'path';

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

	jito_bundles_accepted = 'jito_bundles_accepted',
	jito_bundles_simulation_failure = 'jito_simulation_failure',
	jito_dropped_bundle = 'jito_dropped_bundle',
	jito_landed_tips = 'jito_landed_tips',
	jito_bundle_count = 'jito_bundle_count',
}

const errorCodesToSuppress = [
	6061, // 0x17AD Error Number: 6061. Error Message: Order does not exist.
	6078, // 0x17BE Error Number: 6078. Error Message: PerpMarketNotFound
	6239, // 0x185F Error Number: 6239. Error Message: RevertFill.
	6023, // 0x1787 Error Number: 6023. Error Message: PriceBandsBreached.
];

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

type DLOBBuilderWithProcess = {
	process: ChildProcess;
	ready: boolean;
	marketIndexes: number[];
};

export type TxType = 'fill' | 'settlePnl';
export const TX_TIMEOUT_THRESHOLD_MS = 60_000; // tx considered stale after this time and give up confirming
export const CONFIRM_TX_RATE_LIMIT_BACKOFF_MS = 5_000; // wait this long until trying to confirm tx again if rate limited
export const CONFIRM_TX_INTERVAL_MS = 5_000;
const FILL_ORDER_THROTTLE_BACKOFF = 1000; // the time to wait before trying to fill a throttled (error filling) node again
const CONFIRM_TX_ATTEMPTS = 2;
const SLOTS_UNTIL_JITO_LEADER_TO_SEND = 4;
const SIM_CU_ESTIMATE_MULTIPLIER = 1.15;
const MAX_ACCOUNTS_PER_TX = 64; // solana limit, track https://github.com/solana-labs/solana/issues/27241

const logPrefix = '[SpotFiller]';

export class SpotFillerMultithreaded {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 2000;

	private driftClient: DriftClient;
	/// Connection to use specifically for confirming transactions
	private txConfirmationConnection: Connection;
	private slotSubscriber: SlotSubscriber;
	private globalConfig: GlobalConfig;
	private seenFillableOrders = new Set<string>();
	private blockhashSubscriber: BlockhashSubscriber;
	private fillTxId = 0;
	private subaccount: number;

	private userStatsMap?: UserStatsMap;
	protected hasEnoughSolToFill: boolean = true;

	private phoenixFulfillmentConfigMap: Map<
		number,
		PhoenixV1FulfillmentConfigAccount
	>;
	private openbookFulfillmentConfigMap: Map<
		number,
		OpenbookV2FulfillmentConfigAccount
	>;

	private intervalIds: Array<NodeJS.Timer> = [];
	private throttledNodes = new Map<string, number>();

	private priorityFeeSubscriber: PriorityFeeSubscriberMap;
	private revertOnFailure: boolean;
	private simulateTxForCUEstimate?: boolean;
	private bundleSender?: BundleSender;

	/// stores txSigs that need to been confirmed in a slower loop, and the time they were confirmed
	protected pendingTxSigsToconfirm: LRUCache<
		string,
		{
			ts: number;
			nodeFilled: NodeToFillWithBuffer;
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

	protected rebalanceFiller?: boolean;
	protected jupiterClient?: JupiterClient;

	protected minimumAmountToFill: number;

	protected dlobBuilders: Map<number, DLOBBuilderWithProcess> = new Map();

	protected marketIndexes: Array<number[]>;
	protected marketIndexesFlattened: number[];

	private config: FillerMultiThreadedConfig;

	private dlobHealthy = true;
	private orderSubscriberHealthy = true;

	private lookupTableAccounts: AddressLookupTableAccount[];

	constructor(
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		runtimeSpec: RuntimeSpec,
		globalConfig: GlobalConfig,
		config: FillerMultiThreadedConfig,
		bundleSender?: BundleSender,
		lookupTableAccounts: AddressLookupTableAccount[] = []
	) {
		this.globalConfig = globalConfig;
		if (!this.globalConfig.useJito && runtimeSpec.driftEnv === 'mainnet-beta') {
			throw new Error('Jito is required for spot multithreaded filler');
		}
		this.config = config;
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.driftClient = driftClient;
		this.slotSubscriber = slotSubscriber;
		this.marketIndexes = config.marketIndexes;
		this.marketIndexesFlattened = config.marketIndexes.flat();
		if (globalConfig.txConfirmationEndpoint) {
			this.txConfirmationConnection = new Connection(
				globalConfig.txConfirmationEndpoint
			);
		} else {
			this.txConfirmationConnection = this.driftClient.connection;
		}
		this.runtimeSpec = runtimeSpec;
		this.lookupTableAccounts = lookupTableAccounts;

		this.initializeMetrics(config.metricsPort ?? this.globalConfig.metricsPort);

		const spotMarkets = this.marketIndexesFlattened.map((m) => {
			return {
				marketType: 'spot',
				marketIndex: m,
			};
		});
		spotMarkets.push({
			marketType: 'spot',
			marketIndex: 1,
		}); // For rebalancing
		this.priorityFeeSubscriber = new PriorityFeeSubscriberMap({
			driftMarkets: spotMarkets,
			driftPriorityFeeEndpoint: 'https://dlob.drift.trade',
		});

		this.revertOnFailure = true;
		this.simulateTxForCUEstimate = config.simulateTxForCUEstimate ?? true;
		if (config.rebalanceFiller) {
			this.rebalanceFiller = true;
		}
		logger.info(
			`${this.name}: revertOnFailure: ${this.revertOnFailure}, simulateTxForCUEstimate: ${this.simulateTxForCUEstimate}`
		);

		this.subaccount = config.subaccount ?? 0;
		if (!this.driftClient.hasUser(this.subaccount)) {
			throw new Error(`Subaccount ${this.subaccount} not found in driftClient`);
		}

		this.phoenixFulfillmentConfigMap = new Map<
			number,
			PhoenixV1FulfillmentConfigAccount
		>();
		this.openbookFulfillmentConfigMap = new Map<
			number,
			OpenbookV2FulfillmentConfigAccount
		>();

		if (
			config.rebalanceFiller &&
			this.runtimeSpec.driftEnv === 'mainnet-beta'
		) {
			this.jupiterClient = new JupiterClient({
				connection: this.driftClient.connection,
			});
		}
		logger.info(
			`${this.name}: rebalancing enabled: ${this.jupiterClient !== undefined}`
		);

		if (!validMinimumGasAmount(config.minGasBalanceToFill)) {
			this.minimumAmountToFill = 0.2 * LAMPORTS_PER_SOL;
		} else {
			// @ts-ignore
			this.minimumAmountToFill = config.minimumAmountToFill * LAMPORTS_PER_SOL;
		}

		logger.info(
			`${this.name}: minimumAmountToFill: ${this.minimumAmountToFill}`
		);

		this.userStatsMap = new UserStatsMap(
			this.driftClient,
			new BulkAccountLoader(
				new Connection(this.driftClient.connection.rpcEndpoint),
				'confirmed',
				0
			)
		);
		this.bundleSender = bundleSender;
		this.blockhashSubscriber = new BlockhashSubscriber({
			connection: driftClient.connection,
		});
		this.pendingTxSigsToconfirm = new LRUCache<
			string,
			{
				ts: number;
				nodeFilled: NodeToFillWithBuffer;
				fillTxId: number;
				txType: TxType;
			}
		>({
			max: 10_000,
			ttl: TX_TIMEOUT_THRESHOLD_MS,
			ttlResolution: 1000,
			disposeAfter: this.recordEvictedTxSig.bind(this),
		});

		this.expiredNodesSet = new LRUCache<string, boolean>({
			max: 10_000,
			ttl: TX_TIMEOUT_THRESHOLD_MS,
			ttlResolution: 1000,
		});
	}

	async init() {
		logger.info(`${this.name}: Initializing`);
		await this.blockhashSubscriber.subscribe();
		await this.priorityFeeSubscriber.subscribe();

		this.lookupTableAccounts.push(
			...(await this.driftClient.fetchAllLookupTableAccounts())
		);

		const fillerSolBalance = await this.driftClient.connection.getBalance(
			this.driftClient.authority
		);
		this.hasEnoughSolToFill = fillerSolBalance >= this.minimumAmountToFill;
		logger.info(
			`${this.name}: hasEnoughSolToFill: ${this.hasEnoughSolToFill}, balance: ${fillerSolBalance}`
		);

		({
			phoenixFulfillmentConfigs: this.phoenixFulfillmentConfigMap,
			openbookFulfillmentConfigs: this.openbookFulfillmentConfigMap,
		} = await initializeSpotFulfillmentAccounts(this.driftClient, false));

		this.startProcesses();
		logger.info(`${this.name}: Initialized`);
	}

	public healthCheck(): boolean {
		if (!this.dlobHealthy) {
			logger.error(`${logPrefix} DLOB not healthy`);
		}
		if (!this.orderSubscriberHealthy) {
			logger.error(`${logPrefix} Order subscriber not healthy`);
		}
		return this.dlobHealthy && this.orderSubscriberHealthy;
	}

	private startProcesses() {
		logger.info(`${this.name}: Starting processes`);
		const orderSubscriberArgs = [
			`--drift-env=${this.runtimeSpec.driftEnv}`,
			`--market-type=${this.config.marketType}`,
			`--market-indexes=${this.config.marketIndexes.map(String)}`,
		];
		const user = this.driftClient.getUser(this.subaccount);

		for (const marketIndexes of this.marketIndexes) {
			logger.info(
				`${this.name}: Spawning dlobBuilder for marketIndexes: ${marketIndexes}`
			);
			const dlobBuilderArgs = [
				`--drift-env=${this.runtimeSpec.driftEnv}`,
				`--market-type=${this.config.marketType}`,
				`--market-indexes=${marketIndexes.map(String)}`,
			];

			const dlobBuilderFileName =
				'dlobBuilder' + (isTsRuntime() ? '.ts' : '.js');
			const dlobBuilderProcess = spawnChild(
				path.join(
					__dirname,
					isTsRuntime() ? '..' : '.',
					'filler-common',
					dlobBuilderFileName
				),
				dlobBuilderArgs,
				'dlobBuilder',
				(msg: any) => {
					switch (msg.type) {
						case 'initialized':
							{
								const dlobBuilder = this.dlobBuilders.get(msg.data[0]);
								if (dlobBuilder) {
									dlobBuilder.ready = true;
									for (const marketIndex of msg.data) {
										this.dlobBuilders.set(Number(marketIndex), dlobBuilder);
									}
									logger.info(
										`${logPrefix} dlobBuilderProcess initialized and acknowledged`
									);
								}
							}
							break;
						case 'fillableNodes':
							if (this.dryRun) {
								logger.info(`Fillable node received`);
							} else {
								this.fillNodes(msg.data);
							}
							this.lastTryFillTimeGauge?.setLatestValue(
								Date.now(),
								metricAttrFromUserAccount(
									user.getUserAccountPublicKey(),
									user.getUserAccount()
								)
							);
							break;
						case 'health':
							this.dlobHealthy = msg.data.healthy;
							break;
					}
				},
				'[FillerMultithreaded]'
			);

			dlobBuilderProcess.on('exit', (code) => {
				logger.error(`dlobBuilder exited with code ${code}`);
				process.exit(code || 1);
			});

			for (const marketIndex of marketIndexes) {
				this.dlobBuilders.set(Number(marketIndex), {
					process: dlobBuilderProcess,
					ready: false,
					marketIndexes: marketIndexes.map(Number),
				});
			}

			logger.info(
				`dlobBuilder spawned with pid: ${dlobBuilderProcess.pid} marketIndexes: ${dlobBuilderArgs}`
			);
		}

		const routeMessageToDlobBuilder = (msg: any) => {
			const dlobBuilder = this.dlobBuilders.get(Number(msg.data.marketIndex));
			if (dlobBuilder === undefined) {
				logger.error(
					`Received message for unknown marketIndex: ${msg.data.marketIndex}`
				);
				return;
			}
			if (dlobBuilder.marketIndexes.includes(Number(msg.data.marketIndex))) {
				if (typeof dlobBuilder.process.send == 'function') {
					if (dlobBuilder.ready) {
						dlobBuilder.process.send(msg);
						return;
					}
				}
			}
		};

		const orderSubscriberFileName =
			'orderSubscriberFiltered' + (isTsRuntime() ? '.ts' : '.js');
		const orderSubscriberProcess = spawnChild(
			path.join(
				__dirname,
				isTsRuntime() ? '..' : '.',
				'filler-common',
				orderSubscriberFileName
			),
			orderSubscriberArgs,
			'orderSubscriber',
			(msg: any) => {
				switch (msg.type) {
					case 'userAccountUpdate':
						routeMessageToDlobBuilder(msg);
						break;
					case 'health':
						this.orderSubscriberHealthy = msg.data.healthy;
						break;
				}
			},
			'[FillerMultithreaded]'
		);
		orderSubscriberProcess.on('exit', (code) => {
			logger.error(`orderSubscriber exited with code ${code}`);
			process.exit(code || 1);
		});

		process.on('SIGINT', () => {
			logger.info(`${logPrefix} Received SIGINT, killing children`);
			this.dlobBuilders.forEach((value: DLOBBuilderWithProcess, _: number) => {
				value.process.kill();
			});
			orderSubscriberProcess.kill();
			process.exit(0);
		});

		logger.info(
			`orderSubscriber spawned with pid: ${orderSubscriberProcess.pid}`
		);

		if (this.rebalanceFiller) {
			this.intervalIds.push(
				setInterval(this.rebalanceSpotFiller.bind(this), 60_000)
			);
		}
		this.intervalIds.push(
			setInterval(this.confirmPendingTxSigs.bind(this), CONFIRM_TX_INTERVAL_MS)
		);
		if (this.bundleSender) {
			this.intervalIds.push(
				setInterval(this.recordJitoBundleStats.bind(this), 10_000)
			);
		}
	}

	public async fillNodes(serializedNodesToFill: SerializedNodeToFill[]) {
		if (!this.hasEnoughSolToFill) {
			logger.info('Not enough SOL to fill, skipping fillNodes');
			return;
		}

		logger.debug(`${logPrefix} filling ${serializeNodeToFill.length} nodes...`);

		const deserializedNodesToFill = serializedNodesToFill.map(
			deserializeNodeToFill
		);
		const seenFillableNodes = new Set<string>();
		const filteredFillableNodes = deserializedNodesToFill.filter((node) => {
			const sig = getNodeToFillSignature(node);
			if (seenFillableNodes.has(sig)) {
				return false;
			}
			seenFillableNodes.add(sig);
			return true;
		});
		logger.debug(
			`${logPrefix} filtered down to ${filteredFillableNodes.length} nodes...`
		);

		const buildForBundle = this.shouldBuildForBundle();

		try {
			for (const node of filteredFillableNodes) {
				if (this.seenFillableOrders.has(getNodeToFillSignature(node))) {
					logger.debug(
						// @ts-ignore
						`${logPrefix} already filled order (account: ${
							node.node.userAccount
						}, order ${node.node.order?.orderId.toString()}`
					);
					continue;
				}
				this.seenFillableOrders.add(getNodeToFillSignature(node));
				if (node.makerNodes.length > 0) {
					this.tryFillMultiMakerSpotNodes(node, !!buildForBundle);
				} else {
					this.tryFillSpotNode(node, !!buildForBundle);
				}
			}
		} catch (e) {
			if (e instanceof Error) {
				logger.error(
					`${logPrefix} Error filling nodes: ${e.stack ? e.stack : e.message}`
				);
			}
		}
	}

	protected async tryFillMultiMakerSpotNodes(
		nodeToFill: NodeToFillWithBuffer,
		buildForBundle: boolean
	) {
		let nodeWithMakerSet = nodeToFill;
		const fillTxId = this.fillTxId++;
		while (
			!(await this.fillMultiMakerSpotNodes(
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
				userAccountData: nodeWithMakerSet.userAccountData,
				makerAccountData: nodeWithMakerSet.makerAccountData,
			};
			if (newMakerSet.length === 0) {
				logger.error(
					`No makers left to use for multi maker spot node (fillTxId: ${fillTxId})`
				);
				return;
			}
		}
	}

	private async fillMultiMakerSpotNodes(
		fillTxId: number,
		nodeToFill: NodeToFillWithBuffer,
		buildForBundle: boolean
	): Promise<boolean> {
		const spotPrecision = TEN.pow(
			new BN(
				this.driftClient.getSpotMarketAccount(
					nodeToFill.node.order!.marketIndex
				)!.decimals
			)
		);

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
				this.slotSubscriber.getSlot(),
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
			const user = this.driftClient.getUser(this.subaccount);

			let makerInfosToUse = makerInfos;
			const buildTxWithMakerInfos = async (
				makers: DataAndSlot<MakerInfo>[]
			): Promise<SimulateAndGetTxWithCUsResponse | undefined> => {
				if (makers.length === 0) {
					return undefined;
				}

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
								this.priorityFeeSubscriber.getPriorityFees(
									'spot',
									nodeToFill.node.order!.marketIndex
								)!.high
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
						makers.map((m) => m.data),
						undefined,
						user.userAccountPublicKey
					)
				);

				if (this.revertOnFailure) {
					ixs.push(
						await this.driftClient.getRevertFillIx(user.userAccountPublicKey)
					);
				}

				ixs.push(
					new TransactionInstruction({
						programId: MEMO_PROGRAM_ID,
						keys: [],
						data: Buffer.from(`mm-spot ${fillTxId} ${makers.length}`, 'utf-8'),
					})
				);

				const simResult = await simulateAndGetTxWithCUs({
					ixs,
					connection: this.driftClient.connection,
					payerPublicKey: this.driftClient.wallet.publicKey,
					lookupTableAccounts: this.lookupTableAccounts,
					cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
					doSimulation: this.simulateTxForCUEstimate,
					recentBlockhash: await this.getBlockhashForTx(),
					dumpTx: false,
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

				return simResult;
			};

			let simResult = await buildTxWithMakerInfos(makerInfosToUse);
			if (simResult === undefined) {
				return true;
			}
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
			}

			if (makerInfosToUse.length === 0) {
				logger.error(
					`No makerInfos left to use for multi maker spot node (fillTxId: ${fillTxId})`
				);
				return true;
			}
			if (simResult === undefined) {
				logger.error(
					`No simResult after ${attempt} attempts (fillTxId: ${fillTxId})`
				);
				return true;
			}

			txAccounts = simResult.tx.message.getAccountKeys({
				addressLookupTableAccounts: this.lookupTableAccounts,
			}).length;

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

	protected async tryFillSpotNode(
		nodeToFill: NodeToFillWithBuffer,
		buildForBundle: boolean
	) {
		const fillTxId = this.fillTxId++;
		const node = nodeToFill.node!;
		const order = node.order!;
		const spotMarket = this.driftClient.getSpotMarketAccount(
			order.marketIndex
		)!;
		const spotMarketPrecision = TEN.pow(new BN(spotMarket.decimals));

		const { takerUser, takerUserPubKey, takerUserSlot, marketType } =
			await this.getNodeFillInfo(nodeToFill);

		if (!isVariant(marketType, 'spot')) {
			throw new Error('expected spot market type');
		}

		const fallbackSource = isVariant(order.direction, 'short')
			? nodeToFill.fallbackBidSource
			: nodeToFill.fallbackAskSource;

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
		} else {
			logger.error(
				`makerInfo doesnt exist and unknown fallback source: ${fallbackSource} (fillTxId: ${fillTxId})`
			);
		}

		logMessageForNodeToFill(
			nodeToFill,
			takerUserPubKey,
			takerUserSlot,
			[],
			this.slotSubscriber.getSlot(),
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
				this.priorityFeeSubscriber.getPriorityFees(
					'spot',
					nodeToFill.node.order!.marketIndex
				)!.high
			);
			logger.info(`(fillTxId: ${fillTxId}) Using priority fee: ${priorityFee}`);
			ixs.push(
				ComputeBudgetProgram.setComputeUnitPrice({
					microLamports: priorityFee,
				})
			);
		}

		const user = this.driftClient.getUser(this.subaccount);
		ixs.push(
			await this.driftClient.getFillSpotOrderIx(
				new PublicKey(takerUserPubKey),
				takerUser,
				nodeToFill.node.order,
				fulfillmentConfig,
				undefined,
				undefined,
				user.userAccountPublicKey
			)
		);

		if (this.revertOnFailure) {
			ixs.push(
				await this.driftClient.getRevertFillIx(user.userAccountPublicKey)
			);
		}

		ixs.push(
			new TransactionInstruction({
				programId: MEMO_PROGRAM_ID,
				keys: [],
				data: Buffer.from(`ff-spot ${fillTxId}`, 'utf-8'),
			})
		);

		const simResult = await simulateAndGetTxWithCUs({
			ixs,
			connection: this.driftClient.connection,
			payerPublicKey: this.driftClient.wallet.publicKey,
			lookupTableAccounts: this.lookupTableAccounts,
			cuLimitMultiplier: SIM_CU_ESTIMATE_MULTIPLIER,
			doSimulation: this.simulateTxForCUEstimate,
			recentBlockhash: await this.getBlockhashForTx(),
			dumpTx: false,
		});
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

	protected async getNodeFillInfo(nodeToFill: NodeToFillWithBuffer): Promise<{
		makerInfos: Array<DataAndSlot<MakerInfo>>;
		takerUser: UserAccount;
		takerUserSlot: number;
		takerUserPubKey: string;
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

			const makerInfoMap = new Map(JSON.parse(nodeToFill.makerAccountData));
			for (const [makerAccount, makerNodes] of makerNodesMap) {
				const makerNode = makerNodes[0];
				const makerUserAccount = decodeUser(
					// @ts-ignore
					Buffer.from(makerInfoMap.get(makerAccount)!.data)
				);
				const makerAuthority = makerUserAccount.authority;
				const makerUserStats = (
					await this.userStatsMap!.mustGet(makerAuthority.toString())
				).userStatsAccountPublicKey;
				makerInfos.push({
					slot: this.slotSubscriber.getSlot(),
					data: {
						maker: new PublicKey(makerAccount),
						makerUserAccount: makerUserAccount,
						order: makerNode.order,
						makerStats: makerUserStats,
					},
				});
			}
		}

		const takerUserAccount = decodeUser(
			// @ts-ignore
			Buffer.from(nodeToFill.userAccountData.data)
		);

		return Promise.resolve({
			makerInfos,
			takerUser: takerUserAccount,
			takerUserSlot: this.slotSubscriber.getSlot(),
			takerUserPubKey: nodeToFill.node.userAccount!,
			marketType: nodeToFill.node.order!.marketType,
		});
	}

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

	private clearThrottledNode(nodeSignature: string) {
		this.throttledNodes.delete(nodeSignature);
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

		this.metrics?.finalizeObservables();

		this.runtimeSpecsGauge.setLatestValue(this.bootTimeMs, this.runtimeSpec);
		this.metricsInitialized = true;
	}

	protected recordEvictedTxSig(
		_tsTxSigAdded: { ts: number; nodeFilled: NodeToFillWithBuffer },
		txSig: string,
		reason: 'evict' | 'set' | 'delete'
	) {
		if (reason === 'evict' || reason === 'delete') {
			logger.debug(
				`Removing tx sig ${txSig} from this.txSigsToConfirm, new size: ${this.pendingTxSigsToconfirm.size}`
			);
		}
		if (reason === 'evict') {
			logger.info(
				`${this.name}: Evicted tx sig ${txSig} from this.txSigsToConfirm`
			);
			const user = this.driftClient.getUser(this.subaccount);
			this.evictedPendingTxSigsToConfirmCounter?.add(1, {
				...metricAttrFromUserAccount(
					user.userAccountPublicKey,
					user.getUserAccount()
				),
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

	protected slotsUntilJitoLeader(): number | undefined {
		return this.bundleSender?.slotsUntilNextLeader();
	}

	protected recordJitoBundleStats() {
		const user = this.driftClient.getUser(this.subaccount);
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

	protected async confirmPendingTxSigs() {
		const user = this.driftClient.getUser(this.subaccount);
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
					logger.debug(`Confirming transactions: ${j}/${txs.length}`);
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
							logger.debug(
								`Removing expired txSig ${txSig} from pendingTxSigsToconfirm, new size: ${this.pendingTxSigsToconfirm.size}`
							);
							this.pendingTxSigsToconfirm.delete(txSig);
						}
					} else {
						logger.info(
							`Tx landed (fillTxId: ${fillTxId}) (txType: ${txType}): ${txSig}, tx age: ${
								txAge / 1000
							} s`
						);
						logger.debug(
							`Removing confirmed txSig ${txSig} from pendingTxSigsToconfirm, new size: ${this.pendingTxSigsToconfirm.size}`
						);
						this.pendingTxSigsToconfirm.delete(txSig);
						if (txType === 'fill') {
							try {
								const result = await this.handleTransactionLogs(
									// @ts-ignore
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
							} catch (e) {
								const err = e as Error;
								logger.error(
									`Error handling transaction logs: ${err.message}-${err.stack}`
								);
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
				logger.error(
					`Other error confirming tx sigs: ${err.message}-${err.stack}`
				);
			}
		} finally {
			this.confirmLoopRunning = false;
		}
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

	protected async registerTxSigToConfirm(
		txSig: TransactionSignature,
		now: number,
		nodeFilled: NodeToFillWithBuffer,
		fillTxId: number,
		txType: TxType
	) {
		this.pendingTxSigsToconfirm.set(txSig, {
			ts: now,
			nodeFilled,
			fillTxId,
			txType,
		});
		const user = this.driftClient.getUser(this.subaccount);
		this.sentTxsCounter?.add(1, {
			txType,
			...metricAttrFromUserAccount(
				user.userAccountPublicKey,
				user.getUserAccount()
			),
		});
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

	private async sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	protected async sendFillTxAndParseLogs(
		fillTxId: number,
		nodeSent: NodeToFillWithBuffer,
		tx: VersionedTransaction,
		buildForBundle: boolean,
		lutAccounts: Array<AddressLookupTableAccount>
	) {
		// @ts-ignore;
		tx.sign([this.driftClient.wallet.payer]);
		const txSig = bs58.encode(tx.signatures[0]);

		if (buildForBundle) {
			await this.sendTxThroughJito(tx, fillTxId, txSig);
		} else if (this.canSendOutsideJito()) {
			this.registerTxSigToConfirm(
				txSig,
				Date.now(),
				nodeSent,
				fillTxId,
				'fill'
			);

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
							const user = this.driftClient.getUser(this.subaccount);
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

		if (nodeFilled.node === undefined || nodeFilled.node.order === undefined) {
			logger.error(`nodeFilled.node or nodeFilled.node.order is undefined!`);
			throw new Error(`nodeFilled.node or nodeFilled.node.order is undefined!`);
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

	protected async rebalanceSpotFiller() {
		logger.info(`Rebalancing filler`);
		const fillerSolBalance = await this.driftClient.connection.getBalance(
			this.driftClient.authority
		);

		this.hasEnoughSolToFill = fillerSolBalance >= this.minimumAmountToFill;

		if (this.jupiterClient !== undefined) {
			logger.info(`Swapping USDC for SOL to rebalance filler`);
			swapFillerHardEarnedUSDCForSOL(
				this.priorityFeeSubscriber,
				this.driftClient,
				this.jupiterClient,
				await this.getBlockhashForTx(),
				this.subaccount
			).then(async () => {
				const fillerSolBalanceAfterSwap =
					await this.driftClient.connection.getBalance(
						this.driftClient.authority,
						'processed'
					);
				this.hasEnoughSolToFill =
					fillerSolBalanceAfterSwap >= this.minimumAmountToFill;
			});
		} else {
			throw new Error('Jupiter client not initialized');
		}
	}
}
