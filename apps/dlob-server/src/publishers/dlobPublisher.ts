import { Connection, Commitment, PublicKey, Keypair } from '@solana/web3.js';

import {
	DriftClient,
	initialize,
	DriftEnv,
	UserMap,
	Wallet,
	BulkAccountLoader,
	SlotSource,
	DriftClientSubscriptionConfig,
	SlotSubscriber,
	OracleInfo,
	PerpMarketConfig,
	SpotMarketConfig,
	decodeName,
	ONE,
	OrderSubscriberConfig,
	GrpcConfigs,
} from '@velocity-exchange/sdk';
import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';

import { logger, setLogLevel } from '../utils/logger';
import { SubscriberLookup, parsePositiveIntArray, sleep } from '../utils/utils';
import {
	DLOBSubscriberIO,
	wsMarketInfo,
} from '../dlob-subscriber/DLOBSubscriberIO';
import {
	DLOBProvider,
	getDLOBProviderFromOrderSubscriber,
	getDLOBProviderFromUserMap,
} from '../dlobProvider';
import FEATURE_FLAGS from '../utils/featureFlags';
import express, { Response, Request } from 'express';
import { handleHealthCheck } from '../core/middleware';
import { setGlobalDispatcher, Agent } from 'undici';
import { Metrics } from '../core/metricsV2';
import { OrderSubscriberFiltered } from '../dlob-subscriber/OrderSubscriberFiltered';
import {
	FillQualityAnalyticsRepository,
	TakerFillVsOracleBpsRedisResult,
} from '../athena/repositories/fillQualityAnalytics';
import { CommitmentLevel } from '@velocity-exchange/sdk/lib/node/isomorphic/grpc';

setGlobalDispatcher(
	new Agent({
		connections: 200,
	})
);

require('dotenv').config();
const stateCommitment: Commitment = 'confirmed';
const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const commitHash = process.env.COMMIT;
const metricsPort = process.env.METRICS_PORT
	? parseInt(process.env.METRICS_PORT)
	: 9464;

const REDIS_CLIENT = process.env.REDIS_CLIENT || 'DLOB';

// Set up express for health checks
const app = express();

// init metrics
const metricsV2 = new Metrics('dlob-publisher', undefined, metricsPort);
const healthStatusGauge = metricsV2.addGauge(
	'health_status',
	'Health check status'
);
const dlobSlotGauge = metricsV2.addGauge(
	'dlob_slot',
	'Last updated slot of DLOB'
);
const oracleSlotGauge = metricsV2.addGauge(
	'oracle_slot',
	'Last updated slot of oracle'
);
const marketSlotGauge = metricsV2.addGauge(
	'market_slot',
	'Last updated slot of market account'
);
const kinesisRecordsSentCounter = metricsV2.addCounter(
	'kinesis_records_sent',
	'Number of records sent to Kinesis'
);
const tobResubscribeCounter = metricsV2.addCounter(
	'tob_resubscribe',
	'Number of TOB resubscribes triggered'
);
const tobStuckGauge = metricsV2.addGauge(
	'tob_stuck_duration',
	'Duration TOB has been stuck for each market'
);
const takerFillBpsFromOracleGauge = metricsV2.addGauge(
	'taker_fill_bps_from_oracle',
	'Taker fill BPS from oracle by market, side, and cohort'
);
metricsV2.finalizeObservables();

//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });
let driftClient: DriftClient;

setLogLevel('debug');

const useGrpc = process.env.USE_GRPC?.toLowerCase() === 'true';
const useWebsocket = process.env.USE_WEBSOCKET?.toLowerCase() === 'true';

const token = process.env.TOKEN;
const endpoint = process.env.ENDPOINT;
const grpcEndpoint = useGrpc
	? process.env.GRPC_ENDPOINT ?? endpoint + `/${token}`
	: '';
const grpcClient = (process.env.GRPC_CLIENT ??
	'yellowstone') as GrpcConfigs['client'];

const wsEndpoint = process.env.WS_ENDPOINT;
const useOrderSubscriber =
	process.env.USE_ORDER_SUBSCRIBER?.toLowerCase() === 'true';

const ORDERBOOK_UPDATE_INTERVAL =
	parseInt(process.env.ORDERBOOK_UPDATE_INTERVAL) || 400;
const WS_FALLBACK_FETCH_INTERVAL = 60_000;

const KILLSWITCH_SLOT_DIFF_THRESHOLD =
	parseInt(process.env.KILLSWITCH_SLOT_DIFF_THRESHOLD) || 200;

// Fill Quality Analytics configuration
const ENABLE_FILL_QUALITY_ANALYTICS =
	process.env.ENABLE_FILL_QUALITY_ANALYTICS?.toLowerCase() === 'true';
const FILL_QUALITY_ANALYTICS_INTERVAL =
	parseInt(process.env.FILL_QUALITY_ANALYTICS_INTERVAL) || 300_000; // 5 minutes default
const FILL_QUALITY_ANALYTICS_LOOKBACK_MS =
	parseInt(process.env.FILL_QUALITY_ANALYTICS_LOOKBACK_MS) || 86_400_000; // 24 hours default
const FILL_QUALITY_ANALYTICS_SMOOTHING_MINUTES =
	parseInt(process.env.FILL_QUALITY_ANALYTICS_SMOOTHING_MINUTES) || 60;

// TOB monitoring configuration - defaults to true if not set
const ENABLE_TOB_MONITORING =
	!process.env.ENABLE_TOB_MONITORING ||
	process.env.ENABLE_TOB_MONITORING?.toLowerCase() === 'true';
const TOB_CHECK_INTERVAL = parseInt(process.env.TOB_CHECK_INTERVAL) || 60_000; // 1 minute
const TOB_STUCK_THRESHOLD = parseInt(process.env.TOB_STUCK_THRESHOLD) || 60_000; // 1 minute without change
const TOB_MONITORING_ENABLED_PERP_MARKETS = process.env
	.TOB_MONITORING_ENABLED_PERP_MARKETS
	? parsePositiveIntArray(process.env.TOB_MONITORING_ENABLED_PERP_MARKETS)
	: [0, 1, 2]; // Default to SOL-PERP, BTC-PERP, ETH-PERP

// comma separated list of perp market indexes to load: i.e. 0,1,2,3
const PERP_MARKETS_TO_LOAD =
	process.env.PERP_MARKETS_TO_LOAD !== undefined
		? parsePositiveIntArray(process.env.PERP_MARKETS_TO_LOAD)
		: undefined;

// comma separated list of spot market indexes to load: i.e. 0,1,2,3
const SPOT_MARKETS_TO_LOAD =
	process.env.SPOT_MARKETS_TO_LOAD !== undefined
		? parsePositiveIntArray(process.env.SPOT_MARKETS_TO_LOAD)
		: undefined;

const enableOffloadQueue = process.env.ENABLE_OFFLOAD === 'true';
const ignoreList = process.env.IGNORE_LIST?.split(',') || [
	'5N1AcdftujhXWZdBaqfciaKtXn6uVBKjmgwf6aQxR1vW',
];

logger.info(`RPC endpoint:  ${endpoint}`);
logger.info(`WS endpoint:   ${wsEndpoint}`);
logger.info(`GRPC endpoint: ${grpcEndpoint}`);
logger.info(`GRPC Token:    ${token}`);
logger.info(
	`useOrderSubscriber: ${useOrderSubscriber}, useWebsocket: ${useWebsocket}, useGrpc: ${useGrpc}`
);
logger.info(`DriftEnv:     ${driftEnv}`);
logger.info(`Commit:       ${commitHash}`);
logger.info(
	`TOB Monitoring: ${ENABLE_TOB_MONITORING ? 'enabled' : 'disabled'}`
);
if (ENABLE_TOB_MONITORING) {
	logger.info(`TOB Check Interval: ${TOB_CHECK_INTERVAL}ms`);
	logger.info(`TOB Stuck Threshold: ${TOB_STUCK_THRESHOLD}ms`);
	logger.info(
		`TOB Monitoring Markets: ${TOB_MONITORING_ENABLED_PERP_MARKETS.join(', ')}`
	);
}
logger.info(
	`Fill Quality Analytics: ${
		ENABLE_FILL_QUALITY_ANALYTICS ? 'enabled' : 'disabled'
	}`
);
if (ENABLE_FILL_QUALITY_ANALYTICS) {
	logger.info(
		`Fill Quality Analytics Interval: ${FILL_QUALITY_ANALYTICS_INTERVAL}ms`
	);
	logger.info(
		`Fill Quality Analytics Lookback: ${FILL_QUALITY_ANALYTICS_LOOKBACK_MS}ms`
	);
	logger.info(
		`Fill Quality Analytics Smoothing: ${FILL_QUALITY_ANALYTICS_SMOOTHING_MINUTES} minutes`
	);
}

let MARKET_SUBSCRIBERS: SubscriberLookup = {};

const getMarketsAndOraclesToLoad = (
	sdkConfig: any
): {
	perpMarketInfos: wsMarketInfo[];
	spotMarketInfos: wsMarketInfo[];
	oracleInfos?: OracleInfo[];
} => {
	const oracleInfos: OracleInfo[] = [];
	const oraclesTracked = new Set();
	const perpMarketInfos: wsMarketInfo[] = [];
	const spotMarketInfos: wsMarketInfo[] = [];

	// only watch all markets if neither env vars are specified
	const noMarketsSpecified = !PERP_MARKETS_TO_LOAD && !SPOT_MARKETS_TO_LOAD;

	let perpIndexes = PERP_MARKETS_TO_LOAD;
	if (!perpIndexes) {
		if (noMarketsSpecified) {
			perpIndexes = sdkConfig.PERP_MARKETS.map((m) => m.marketIndex);
		} else {
			perpIndexes = [];
		}
	}
	let spotIndexes = SPOT_MARKETS_TO_LOAD;
	if (!spotIndexes) {
		if (noMarketsSpecified) {
			spotIndexes = sdkConfig.SPOT_MARKETS.map((m) => m.marketIndex);
		} else {
			spotIndexes = [];
		}
	}

	if (perpIndexes.length > 0) {
		for (const idx of perpIndexes) {
			const perpMarketConfig = sdkConfig.PERP_MARKETS[idx] as PerpMarketConfig;
			if (!perpMarketConfig) {
				throw new Error(`Perp market config for ${idx} not found`);
			}
			const oracleKey = perpMarketConfig.oracle.toBase58();
			if (!oraclesTracked.has(oracleKey)) {
				logger.info(`Tracking oracle ${oracleKey} for perp market ${idx}`);
				oracleInfos.push({
					publicKey: perpMarketConfig.oracle,
					source: perpMarketConfig.oracleSource,
				});
				oraclesTracked.add(oracleKey);
			}
			perpMarketInfos.push({
				marketIndex: perpMarketConfig.marketIndex,
				marketName: perpMarketConfig.symbol,
			});
		}
		logger.info(
			`DlobPublisher tracking perp markets: ${JSON.stringify(perpMarketInfos)}`
		);
	}

	if (spotIndexes.length > 0) {
		for (const idx of spotIndexes) {
			const spotMarketConfig = sdkConfig.SPOT_MARKETS[idx] as SpotMarketConfig;
			if (!spotMarketConfig) {
				throw new Error(`Spot market config for ${idx} not found`);
			}
			const oracleKey = spotMarketConfig.oracle.toBase58();
			if (!oraclesTracked.has(oracleKey)) {
				logger.info(`Tracking oracle ${oracleKey} for spot market ${idx}`);
				oracleInfos.push({
					publicKey: spotMarketConfig.oracle,
					source: spotMarketConfig.oracleSource,
				});
				oraclesTracked.add(oracleKey);
			}
			spotMarketInfos.push({
				marketIndex: spotMarketConfig.marketIndex,
				marketName: spotMarketConfig.symbol,
			});
		}
		logger.info(
			`DlobPublisher tracking spot markets: ${JSON.stringify(spotMarketInfos)}`
		);
	}

	return {
		perpMarketInfos,
		spotMarketInfos,
		oracleInfos,
	};
};

const initializeAllMarketSubscribers = async (driftClient: DriftClient) => {
	const markets: SubscriberLookup = {};

	for (const market of driftClient.getSpotMarketAccounts()) {
		markets[market.marketIndex] = {
			tickSize: market?.orderTickSize ?? ONE,
		};
	}

	return markets;
};

const main = async () => {
	const wallet = new Wallet(new Keypair());
	const clearingHousePublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const redisClient = new RedisClient({
		prefix: RedisClientPrefix[REDIS_CLIENT],
	});
	await redisClient.connect();

	const indicativeRedisClient = new RedisClient({});
	await indicativeRedisClient.connect();

	const connection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
	});

	// only set when polling
	let bulkAccountLoader: BulkAccountLoader | undefined;

	// only set when using websockets
	let slotSubscriber: SlotSubscriber | undefined;

	let accountSubscription: DriftClientSubscriptionConfig;
	let slotSource: SlotSource;

	// NOTE: disable GRPC for general driftClient subscriptions until we can reliably subscribe
	// to multiple streams. Currently this causes the nodes to start killing connections.
	//
	// USE_GRPC=true will override websocket
	// if (useGrpc) {
	// 	accountSubscription = {
	// 		type: 'grpc',
	// 		resubTimeoutMs: 30_000,
	// 		grpcConfigs: {
	// 			endpoint,
	// 			token,
	// 			channelOptions: {
	// 				'grpc.keepalive_time_ms': 10_000,
	// 				'grpc.keepalive_timeout_ms': 1_000,
	// 				'grpc.keepalive_permit_without_calls': 1,
	// 			},
	// 		},
	// 	};

	// 	slotSubscriber = new SlotSubscriber(connection);
	// 	await slotSubscriber.subscribe();

	// 	slotSource = {
	// 		getSlot: () => slotSubscriber!.getSlot(),
	// 	};
	// }

	if (!useWebsocket) {
		bulkAccountLoader = new BulkAccountLoader(
			connection,
			stateCommitment,
			ORDERBOOK_UPDATE_INTERVAL < 1000 ? 1000 : ORDERBOOK_UPDATE_INTERVAL
		);

		accountSubscription = {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		};

		slotSource = {
			getSlot: () => bulkAccountLoader!.getSlot(),
		};
	} else {
		accountSubscription = {
			type: 'websocket',
			commitment: stateCommitment,
			resubTimeoutMs: 30_000,
			logResubMessages: true,
		};
		slotSubscriber = new SlotSubscriber(connection, {
			resubTimeoutMs: 10_000,
		});
		await slotSubscriber.subscribe();

		slotSource = {
			getSlot: () => slotSubscriber!.getSlot(),
		};
	}

	const { perpMarketInfos, spotMarketInfos, oracleInfos } =
		getMarketsAndOraclesToLoad(sdkConfig);

	driftClient = new DriftClient({
		connection,
		wallet,
		programID: clearingHousePublicKey,
		accountSubscription,
		env: driftEnv,
		perpMarketIndexes: perpMarketInfos.map((m) => m.marketIndex),
		spotMarketIndexes: spotMarketInfos.map((m) => m.marketIndex),
		oracleInfos,
	});

	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	logger.info(
		`DriftClient ProgramId: ${driftClient.program.programId.toBase58()}`
	);
	logger.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	logger.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);

	await driftClient.subscribe();
	driftClient.eventEmitter.on('error', (e) => {
		logger.info('clearing house error');
		logger.error(e);
	});

	logger.info(`Initializing all market subscribers...`);
	const initAllMarketSubscribersStart = Date.now();
	MARKET_SUBSCRIBERS = await initializeAllMarketSubscribers(driftClient);
	logger.info(
		`All market subscribers initialized in ${
			Date.now() - initAllMarketSubscribersStart
		} ms`
	);

	let dlobProvider: DLOBProvider;
	let orderSubscriber: OrderSubscriberFiltered | undefined;

	if (useOrderSubscriber) {
		let subscriptionConfig: OrderSubscriberConfig['subscriptionConfig'] = {
			type: 'polling',
			commitment: stateCommitment,
			frequency: ORDERBOOK_UPDATE_INTERVAL,
		};

		if (useWebsocket) {
			subscriptionConfig = {
				type: 'websocket',
				commitment: stateCommitment,
			};
		}

		// USE_GRPC=true will override websocket
		if (useGrpc) {
			if (!token) {
				throw new Error('TOKEN is required for grpc');
			}
			if (!grpcEndpoint) {
				throw new Error(
					'GRPC_ENDPOINT is required for grpc (or ENDPOINT and TOKEN)'
				);
			}
			if (useWebsocket) {
				logger.warn('USE_GRPC overriding USE_WEBSOCKET');
			}
			subscriptionConfig = {
				type: 'grpc',
				grpcConfigs: {
					endpoint: grpcEndpoint,
					token: token,
					commitmentLevel: CommitmentLevel.CONFIRMED,
					channelOptions: {
						grpcKeepAliveTimeout: 1_000,
						grpcTcpKeepalive: 10_000,
					},
					client: grpcClient,
				},
				commitment: stateCommitment,
			};
		}

		orderSubscriber = new OrderSubscriberFiltered({
			driftClient,
			subscriptionConfig,
			ignoreList,
		});

		dlobProvider = getDLOBProviderFromOrderSubscriber(orderSubscriber);

		slotSource = {
			getSlot: () => orderSubscriber.getSlot(),
		};
	} else {
		const userMap = new UserMap({
			driftClient,
			subscriptionConfig: {
				type: 'websocket',
				resubTimeoutMs: 30_000,
				commitment: stateCommitment,
			},
			skipInitialLoad: false,
			includeIdle: false,
		});

		dlobProvider = getDLOBProviderFromUserMap(userMap);
	}

	await dlobProvider.subscribe();

	const dlobSubscriber = new DLOBSubscriberIO({
		driftClient,
		env: driftEnv,
		dlobSource: dlobProvider,
		slotSource,
		updateFrequency: ORDERBOOK_UPDATE_INTERVAL,
		redisClient,
		spotMarketSubscribers: MARKET_SUBSCRIBERS,
		perpMarketInfos,
		spotMarketInfos,
		killSwitchSlotDiffThreshold: KILLSWITCH_SLOT_DIFF_THRESHOLD,
	});
	await dlobSubscriber.subscribe();

	const dlobSubscriberIndicative = new DLOBSubscriberIO({
		driftClient,
		env: driftEnv,
		dlobSource: dlobProvider,
		slotSource,
		updateFrequency: ORDERBOOK_UPDATE_INTERVAL,
		redisClient,
		spotMarketSubscribers: MARKET_SUBSCRIBERS,
		perpMarketInfos,
		spotMarketInfos,
		killSwitchSlotDiffThreshold: KILLSWITCH_SLOT_DIFF_THRESHOLD,
		indicativeQuotesRedisClient: indicativeRedisClient,
		enableOffloadQueue,
		offloadQueueCounter: kinesisRecordsSentCounter,
	});
	await dlobSubscriberIndicative.subscribe();

	if (useWebsocket && !FEATURE_FLAGS.DISABLE_GPA_REFRESH) {
		const recursiveFetch = (delay = WS_FALLBACK_FETCH_INTERVAL) => {
			setTimeout(() => {
				dlobProvider
					.fetch()
					.catch((e) => {
						logger.error('Failed to fetch GPA');
						console.log(e);
					})
					.finally(() => {
						// eslint-disable-next-line @typescript-eslint/no-unused-vars
						recursiveFetch();
					});
			}, delay);
		};
		recursiveFetch();
	}

	setInterval(() => {
		const slot = slotSource.getSlot();
		perpMarketInfos.forEach((market) => {
			const oracleDataAndSlot = driftClient.getOracleDataForPerpMarket(
				market.marketIndex
			);
			const marketAccount =
				driftClient.accountSubscriber.getMarketAccountAndSlot(
					market.marketIndex
				);
			dlobSlotGauge.setLatestValue(slot, {
				marketIndex: market.marketIndex,
				marketType: 'perp',
				marketName: market.marketName,
				redisClient: REDIS_CLIENT,
				redisPrefix: RedisClientPrefix[REDIS_CLIENT],
			});
			oracleSlotGauge.setLatestValue(oracleDataAndSlot.slot.toNumber(), {
				marketIndex: market.marketIndex,
				marketType: 'perp',
				marketName: market.marketName,
				redisClient: REDIS_CLIENT,
				redisPrefix: RedisClientPrefix[REDIS_CLIENT],
			});
			marketSlotGauge.setLatestValue(marketAccount.slot, {
				marketIndex: market.marketIndex,
				marketType: 'perp',
				marketName: market.marketName,
				redisClient: REDIS_CLIENT,
				redisPrefix: RedisClientPrefix[REDIS_CLIENT],
			});
		});
		spotMarketInfos.forEach((market) => {
			const oracleDataAndSlot = driftClient.getOracleDataForSpotMarket(
				market.marketIndex
			);
			const marketAccount =
				driftClient.accountSubscriber.getSpotMarketAccountAndSlot(
					market.marketIndex
				);
			dlobSlotGauge.setLatestValue(slot, {
				marketIndex: market.marketIndex,
				marketType: 'spot',
				marketName: market.marketName,
				redisClient: REDIS_CLIENT,
				redisPrefix: RedisClientPrefix[REDIS_CLIENT],
			});
			oracleSlotGauge.setLatestValue(oracleDataAndSlot.slot.toNumber(), {
				marketIndex: market.marketIndex,
				marketType: 'spot',
				marketName: market.marketName,
				redisClient: REDIS_CLIENT,
				redisPrefix: RedisClientPrefix[REDIS_CLIENT],
			});
			marketSlotGauge.setLatestValue(marketAccount.slot, {
				marketIndex: market.marketIndex,
				marketType: 'spot',
				marketName: market.marketName,
				redisClient: REDIS_CLIENT,
				redisPrefix: RedisClientPrefix[REDIS_CLIENT],
			});
		});
	}, 10_000);

	// TOB monitoring for configured perp markets to detect stuck orders
	// Check if this node has any TOB monitoring markets configured
	const tobMonitoringMarketsInThisNode =
		TOB_MONITORING_ENABLED_PERP_MARKETS.filter((marketIndex) =>
			perpMarketInfos.some((market) => market.marketIndex === marketIndex)
		);

	const shouldEnableTobMonitoring =
		ENABLE_TOB_MONITORING &&
		useOrderSubscriber &&
		tobMonitoringMarketsInThisNode.length > 0;

	// Track last TOB update times and order IDs for each TOB monitoring market
	const lastTobUpdateTimes = new Map<number, number>();
	const lastTobOrderIds = new Map<
		number,
		{ bidOrderId: string; askOrderId: string }
	>();

	// Initialize TOB tracking for TOB monitoring markets in this node
	tobMonitoringMarketsInThisNode.forEach((marketIndex) => {
		lastTobUpdateTimes.set(marketIndex, Date.now());
		lastTobOrderIds.set(marketIndex, { bidOrderId: '', askOrderId: '' });
	});

	// Log TOB monitoring status
	if (ENABLE_TOB_MONITORING) {
		logger.info(
			`TOB Monitoring Markets in this node: ${tobMonitoringMarketsInThisNode.join(
				', '
			)}`
		);
		logger.info(
			`TOB Monitoring active: ${shouldEnableTobMonitoring ? 'yes' : 'no'}`
		);
	}

	// TOB monitoring function
	const checkTobForStuckOrders = async () => {
		if (!shouldEnableTobMonitoring) {
			return; // Only monitor when using OrderSubscriber, TOB monitoring is enabled, and node has major markets
		}

		logger.debug('Starting TOB monitoring check');

		const currentTime = Date.now();

		for (const marketIndex of tobMonitoringMarketsInThisNode) {
			try {
				// Get current TOB from DLOB
				const slot = slotSource.getSlot();
				const dlob = await dlobProvider.getDLOB(slot);

				// Get oracle data for the market
				const oracleData =
					driftClient.getMMOracleDataForPerpMarket(marketIndex);

				// Get L3 orderbook to check TOB
				const l3OrderBook = dlob.getL3({
					marketIndex,
					marketType: { perp: {} },
					slot,
					oraclePriceData: oracleData,
				});

				const bestBidOrder = l3OrderBook.bids[0];
				const bestAskOrder = l3OrderBook.asks[0];

				// Track each side independently, even if one side is empty
				const currentBidOrderId = bestBidOrder
					? `${bestBidOrder.maker.toBase58()}-${bestBidOrder.orderId}`
					: '';
				const currentAskOrderId = bestAskOrder
					? `${bestAskOrder.maker.toBase58()}-${bestAskOrder.orderId}`
					: '';

				const currentTobOrderIds = {
					bidOrderId: currentBidOrderId,
					askOrderId: currentAskOrderId,
				};
				const lastTobOrderId = lastTobOrderIds.get(marketIndex);
				const lastUpdate = lastTobUpdateTimes.get(marketIndex);

				// Check if TOB orders have changed on either side
				const tobChanged =
					!lastTobOrderId ||
					lastTobOrderId.bidOrderId !== currentTobOrderIds.bidOrderId ||
					lastTobOrderId.askOrderId !== currentTobOrderIds.askOrderId;

				if (tobChanged) {
					// TOB orders changed, update tracking
					lastTobOrderIds.set(marketIndex, currentTobOrderIds);
					lastTobUpdateTimes.set(marketIndex, currentTime);
					logger.debug(
						`TOB orders updated for market ${marketIndex}: bidOrderId=${
							currentTobOrderIds.bidOrderId || 'none'
						}, askOrderId=${currentTobOrderIds.askOrderId || 'none'}`
					);
				} else if (
					lastUpdate &&
					currentTime - lastUpdate > TOB_STUCK_THRESHOLD
				) {
					// TOB has been stuck for too long, trigger resubscribe
					const stuckDuration = (currentTime - lastUpdate) / 1000;
					logger.warn(
						`TOB stuck for market ${marketIndex} for ${stuckDuration}s, triggering resubscribe`
					);

					// Update metrics
					tobStuckGauge.setLatestValue(stuckDuration, {
						marketIndex: marketIndex.toString(),
						marketType: 'perp',
					});

					// Get the OrderSubscriber instance for resubscribe
					if (orderSubscriber) {
						try {
							// Resubscribe and fetch to clear stuck state
							await orderSubscriber.unsubscribe();
							await orderSubscriber.subscribe();
							await orderSubscriber.fetch();

							logger.info(
								`Successfully resubscribed OrderSubscriber for market ${marketIndex}`
							);

							// Update metrics
							tobResubscribeCounter.add(1, {
								marketIndex: marketIndex.toString(),
								marketType: 'perp',
								success: 'true',
							});

							// Reset the timer after successful resubscribe
							lastTobUpdateTimes.set(marketIndex, currentTime);
						} catch (error) {
							logger.error(
								`Failed to resubscribe OrderSubscriber for market ${marketIndex}:`,
								error
							);

							// Update metrics for failed resubscribe
							tobResubscribeCounter.add(1, {
								marketIndex: marketIndex.toString(),
								marketType: 'perp',
								success: 'false',
							});
						}
					} else {
						logger.error(
							`OrderSubscriber not available for market ${marketIndex}`
						);
					}
				}
			} catch (error) {
				logger.error(`Error checking TOB for market ${marketIndex}:`, error);
			}
		}
	};

	// Start TOB monitoring
	setInterval(checkTobForStuckOrders, TOB_CHECK_INTERVAL);

	// Track last known values for fill quality metrics (per market/side/cohort)
	const lastFillQualityValues = new Map<string, number>();

	// Helper function to update fill quality metric with null tracking
	const updateFillQualityMetric = (
		value: string | number | null | undefined,
		marketIndex: string | number,
		side: string,
		cohort: string
	) => {
		const marketIndexStr = marketIndex.toString();
		const key = `${marketIndexStr}:${side}:${cohort}`;
		const isNull = value === null || value === undefined;

		let valueToUse: number;
		if (isNull) {
			// Use last known value, or 0 if no previous value exists
			valueToUse = lastFillQualityValues.get(key) || 0;
			logger.debug(
				`Null value for market ${marketIndexStr} ${side} ${cohort}, using last known value: ${valueToUse}`
			);
		} else {
			// Use current value and update the last known value
			valueToUse = Number(value);
			lastFillQualityValues.set(key, valueToUse);
		}

		takerFillBpsFromOracleGauge.setLatestValue(valueToUse, {
			marketIndex: marketIndexStr,
			side,
			cohort,
			null: isNull ? 'true' : 'false',
		});
	};

	// Fill Quality Analytics function - fetch and store in Redis
	const fetchAndStoreFillQualityAnalytics = async () => {
		if (!ENABLE_FILL_QUALITY_ANALYTICS) {
			return;
		}

		try {
			logger.info('Starting fill quality analytics fetch');
			const startTime = Date.now();

			const fillQualityRepo = FillQualityAnalyticsRepository();
			const toMs = Date.now();
			const fromMs = toMs - FILL_QUALITY_ANALYTICS_LOOKBACK_MS;

			const results = await fillQualityRepo.getTakerFillVsOracleBps(
				fromMs,
				toMs,
				9, // baseDecimals
				FILL_QUALITY_ANALYTICS_SMOOTHING_MINUTES
			);

			logger.info(
				`Fetched fill quality analytics for ${results.length} markets in ${
					Date.now() - startTime
				}ms`
			);

			// Store results in Redis - one key per market
			const startRedisSet = Date.now();
			for (const result of results) {
				const redisKey = `taker_fill_vs_oracle_bps:market:${result.MarketIndex}`;
				const redisValue = JSON.stringify({
					marketIndex: result.MarketIndex,
					takerBuyBpsFromOracle: {
						all: result.TakerBuyBpsFromOracle_ALL,
						'1e0': result.TakerBuyBpsFromOracle_1e0,
						'1e3': result.TakerBuyBpsFromOracle_1e3,
						'1e4': result.TakerBuyBpsFromOracle_1e4,
						'1e5': result.TakerBuyBpsFromOracle_1e5,
						'1e6': result.TakerBuyBpsFromOracle_1e6,
					},
					takerSellBpsFromOracle: {
						all: result.TakerSellBpsFromOracle_ALL,
						'1e0': result.TakerSellBpsFromOracle_1e0,
						'1e3': result.TakerSellBpsFromOracle_1e3,
						'1e4': result.TakerSellBpsFromOracle_1e4,
						'1e5': result.TakerSellBpsFromOracle_1e5,
						'1e6': result.TakerSellBpsFromOracle_1e6,
					},
					updatedAtTs: Date.now(),
				} as TakerFillVsOracleBpsRedisResult);

				await redisClient.set(redisKey, redisValue);

				updateFillQualityMetric(
					result.TakerBuyBpsFromOracle_ALL,
					result.MarketIndex,
					'buy',
					'all'
				);
				updateFillQualityMetric(
					result.TakerBuyBpsFromOracle_1e0,
					result.MarketIndex,
					'buy',
					'1e0'
				);
				updateFillQualityMetric(
					result.TakerBuyBpsFromOracle_1e3,
					result.MarketIndex,
					'buy',
					'1e3'
				);
				updateFillQualityMetric(
					result.TakerBuyBpsFromOracle_1e4,
					result.MarketIndex,
					'buy',
					'1e4'
				);
				updateFillQualityMetric(
					result.TakerBuyBpsFromOracle_1e5,
					result.MarketIndex,
					'buy',
					'1e5'
				);
				updateFillQualityMetric(
					result.TakerBuyBpsFromOracle_1e6,
					result.MarketIndex,
					'buy',
					'1e6'
				);
				updateFillQualityMetric(
					result.TakerSellBpsFromOracle_ALL,
					result.MarketIndex,
					'sell',
					'all'
				);
				updateFillQualityMetric(
					result.TakerSellBpsFromOracle_1e0,
					result.MarketIndex,
					'sell',
					'1e0'
				);
				updateFillQualityMetric(
					result.TakerSellBpsFromOracle_1e3,
					result.MarketIndex,
					'sell',
					'1e3'
				);
				updateFillQualityMetric(
					result.TakerSellBpsFromOracle_1e4,
					result.MarketIndex,
					'sell',
					'1e4'
				);
				updateFillQualityMetric(
					result.TakerSellBpsFromOracle_1e5,
					result.MarketIndex,
					'sell',
					'1e5'
				);
				updateFillQualityMetric(
					result.TakerSellBpsFromOracle_1e6,
					result.MarketIndex,
					'sell',
					'1e6'
				);

				logger.debug(
					`Stored fill quality analytics for market ${result.MarketIndex}`
				);
			}
			logger.info(
				`Successfully stored fill quality analytics for ${
					results.length
				} markets in Redis in ${Date.now() - startRedisSet}ms`
			);
		} catch (error) {
			logger.error('Error fetching/storing fill quality analytics:', error);
		}
	};

	// Run fill quality analytics fetch immediately on startup, then on interval
	if (ENABLE_FILL_QUALITY_ANALYTICS) {
		fetchAndStoreFillQualityAnalytics().catch((error) => {
			logger.error('Initial fill quality analytics fetch failed:', error);
		});
		setInterval(
			fetchAndStoreFillQualityAnalytics,
			FILL_QUALITY_ANALYTICS_INTERVAL
		);
		logger.info(
			`Fill quality analytics will run every ${FILL_QUALITY_ANALYTICS_INTERVAL}ms`
		);
	}

	const handleStartup = async (_req, res, _next) => {
		if (driftClient.isSubscribed && dlobProvider.size() > 0) {
			res.writeHead(200);
			res.end('OK');
		} else {
			res.writeHead(500);
			res.end('Not ready');
		}
	};

	const handleDebug = async (req: Request, res: Response) => {
		const slot = slotSource.getSlot();
		const slotInfos = [];
		for (const market of driftClient.getPerpMarketAccounts()) {
			const oracleDataAndSlot = driftClient.getOracleDataForPerpMarket(
				market.marketIndex
			);
			const marketSlot = market.amm.lastUpdateSlot.toNumber();
			const oracleSlot = oracleDataAndSlot.slot.toNumber();
			slotInfos.push({
				marketName: decodeName(market.name),
				slot,
				marketSlot,
				oracleSlot,
				marketSlotDiff: marketSlot - slot,
				oracleSlotDiff: oracleSlot - slot,
			});
		}

		for (const market of driftClient.getSpotMarketAccounts()) {
			const oracleDataAndSlot = driftClient.getOracleDataForSpotMarket(
				market.marketIndex
			);
			const oracleSlot = oracleDataAndSlot.slot.toNumber();
			slotInfos.push({
				marketName: decodeName(market.name),
				slot,
				oracleSlot,
				oracleSlotDiff: oracleSlot - slot,
			});
		}

		res.json(slotInfos);
	};
	app.get('/debug', handleDebug);
	app.get('/health', handleHealthCheck(slotSource, healthStatusGauge));
	app.get('/startup', handleStartup);
	app.get('/', handleHealthCheck(slotSource, healthStatusGauge));
	const server = app.listen(8080);

	// Default keepalive is 5s, since the AWS ALB timeout is 60 seconds, clients
	// sometimes get 502s.
	// https://shuheikagawa.com/blog/2019/04/25/keep-alive-timeout/
	// https://stackoverflow.com/a/68922692
	server.keepAliveTimeout = 61 * 1000;
	server.headersTimeout = 65 * 1000;

	console.log('DLOBSubscriber Publishing Messages');
};

async function recursiveTryCatch(f: () => void) {
	try {
		await f();
	} catch (e) {
		console.error(e);
		await sleep(15000);
		await recursiveTryCatch(f);
	}
}

recursiveTryCatch(() => main());

export { sdkConfig, endpoint, wsEndpoint, driftEnv, commitHash, driftClient };
