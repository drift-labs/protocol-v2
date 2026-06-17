import * as fs from 'fs';
import YAML from 'yaml';
import {
	loadCommaDelimitToArray,
	loadCommaDelimitToStringArray,
	parsePositiveIntArray,
} from './utils';
import {
	BN,
	ConfirmationStrategy,
	DriftEnv,
	MarketType,
	PerpMarkets,
} from '@drift-labs/sdk';
import { JitMakerConfig } from './bots/jitMaker';
import { PriceFeedProperty } from '@pythnetwork/pyth-lazer-sdk';

export type BaseBotConfig = {
	botId: string;
	dryRun: boolean;
	/// will override {@link GlobalConfig.metricsPort}
	metricsPort?: number;
	runOnce?: boolean;
};

export type TriggerConfig = BaseBotConfig & {
	triggerPriorityFeeMultiplier?: number;
};

export type UserPnlSettlerConfig = BaseBotConfig & {
	/// perp market indexes to filter for settling pnl
	perpMarketIndicies?: Array<number>;
	/// min abs. USDC threshold before settling pnl
	/// in USDC human terms (100 for 100 USDC)
	settlePnlThresholdUsdc?: number;
	/// max number of users to consider for settling pnl on each iteration
	maxUsersToConsider?: number;
};

export type FillerMultiThreadedConfig = BaseBotConfig & {
	marketType: string;
	marketIndexes: Array<number[]>;
	simulateTxForCUEstimate?: boolean;
	revertOnFailure?: boolean;
	subaccount?: number;

	rebalanceFiller?: boolean;
	rebalanceSettledPnlThreshold?: number;
	minGasBalanceToFill?: number;
	bidToFillerReward?: boolean;
	pythLazerChunkSize?: number;

	triggerPriorityFeeMultiplier?: number;
};

export type FillerConfig = BaseBotConfig & {
	fillerPollingInterval?: number;
	revertOnFailure?: boolean;
	simulateTxForCUEstimate?: boolean;

	rebalanceFiller?: boolean;
	rebalanceSettledPnlThreshold?: number;
	minGasBalanceToFill?: number;

	triggerPriorityFeeMultiplier?: number;
};

export type MakerBidAskTwapCrankConfig = BaseBotConfig & {
	crankIntervalToMarketIndicies?: { [key: number]: number[] };
};

export type SubaccountConfig = {
	[key: number]: Array<number>;
};

export type LiquidatorConfig = BaseBotConfig & {
	disableAutoDerisking: boolean;
	/// @deprecated, use {@link perpSubAccountConfig} to restrict markets
	perpMarketIndicies?: Array<number>;
	/// @deprecated, use {@link spotSubAccountConfig} to restrict markets
	spotMarketIndicies?: Array<number>;
	perpSubAccountConfig?: SubaccountConfig;
	spotSubAccountConfig?: SubaccountConfig;

	// deprecated: use {@link LiquidatorConfig.maxSlippageBps} (misnamed)
	maxSlippagePct?: number;
	maxSlippageBps?: number;

	deriskAuctionDurationSlots?: number;
	twapDurationSec?: number;
	minDepositToLiq?: Map<number, number>;
	excludedAccounts?: Set<string>;
	maxPositionTakeoverPctOfCollateral?: number;
	notifyOnLiquidation?: boolean;

	/// The threshold at which to consider spot asset "dust". Dust will be periodically withdrawn to
	/// authority wallet to free up spot position slots.
	/// In human precision: 100.0 for 100.0 USD worth of spot assets
	spotDustValueThreshold?: number;
	/// Placeholder, liquidator will set this to the raw BN of {@link LiquidatorConfig.spotDustValueThreshold}
	spotDustValueThresholdBN?: BN;
};

export type PythLazerCrankerBotConfig = BaseBotConfig & {
	skipSimulation?: boolean;
	pythLazerChannel?: string;
	ignorePythLazerIds?: number[];
	pythLazerIds?: number[];
	pythLazerIdsByChannel?: {
		real_time: number[];
		'fixed_rate@50ms': number[];
		'fixed_rate@200ms': number[];
	};
	slotStalenessThresholdRestart: number;
	txSuccessRateThreshold: number;
	intervalMs: number;
	onlyCrankUsedOracles?: boolean;
	feedProperties?: PriceFeedProperty[];
};

export type SwitchboardCrankerBotConfig = BaseBotConfig & {
	intervalMs: number;
	queuePubkey: string;
	pullFeedConfigs: {
		[key: string]: {
			pubkey: string;
		};
	};
	writableAccounts?: string[];
};

export type LpPoolTargetBaseCrankerConfig = BaseBotConfig & {
	intervalMs: number;
	lpPoolId: number;
};

export type BotConfigMap = {
	fillerMultithreaded?: FillerMultiThreadedConfig;
	spotFillerMultithreaded?: FillerMultiThreadedConfig;
	filler?: FillerConfig;
	fillerLite?: FillerConfig;
	spotFiller?: FillerConfig;
	trigger?: TriggerConfig;
	liquidator?: LiquidatorConfig;
	floatingMaker?: BaseBotConfig;
	ifRevenueSettler?: BaseBotConfig;
	fundingRateUpdater?: BaseBotConfig;
	userPnlSettler?: UserPnlSettlerConfig;
	userIdleFlipper?: BaseBotConfig;
	markTwapCrank?: MakerBidAskTwapCrankConfig;
	pythLazerCranker?: PythLazerCrankerBotConfig;
	switchboardCranker?: SwitchboardCrankerBotConfig;
	swiftTaker?: BaseBotConfig;
	swiftMaker?: BaseBotConfig;
	swiftPlacer?: BaseBotConfig;
	jitMaker?: JitMakerConfig;
	lpTargetBaseCranker?: LpPoolTargetBaseCrankerConfig;
};

export interface GlobalConfig {
	driftEnv: DriftEnv;
	/// rpc endpoint to use
	endpoint: string;
	/// ws endpoint to use (inferred from endpoint using web3.js rules, only provide if you want to use a different one)
	wsEndpoint?: string;
	hermesEndpoint?: string;
	lazerHttpEndpoints?: string[];
	lazerEndpoints?: string[];
	lazerToken?: string;

	// Optional to specify markets loaded by drift client
	perpMarketsToLoad?: Array<number>;
	spotMarketsToLoad?: Array<number>;

	/// helius endpoint to use helius priority fee strategy
	heliusEndpoint?: string;
	/// additional rpc endpoints to send transactions to
	additionalSendTxEndpoints?: string[];
	/// endpoint to confirm txs on
	txConfirmationEndpoint?: string;
	/// default metrics port to use, will be overridden by {@link BaseBotConfig.metricsPort} if provided
	metricsPort?: number;
	/// disable all metrics
	disableMetrics?: boolean;

	priorityFeeMethod?: string;
	maxPriorityFeeMicroLamports?: number;
	resubTimeoutMs?: number;
	priorityFeeMultiplier?: number;
	keeperPrivateKey?: string;
	initUser?: boolean;
	testLiveness?: boolean;
	cancelOpenOrders?: boolean;
	closeOpenPositions?: boolean;
	forceDeposit?: number | null;
	websocket?: boolean;
	eventSubscriber?: false;
	runOnce?: boolean;
	debug?: boolean;
	subaccounts?: Array<number>;

	eventSubscriberPollingInterval: number;
	bulkAccountLoaderPollingInterval: number;

	useJito?: boolean;
	jitoStrategy?: 'jito-only' | 'non-jito-only' | 'hybrid';
	jitoBlockEngineUrl?: string;
	jitoAuthPrivateKey?: string;
	jitoMinBundleTip?: number;
	jitoMaxBundleTip?: number;
	jitoMaxBundleFailCount?: number;
	jitoTipMultiplier?: number;
	onlySendDuringJitoLeader?: boolean;

	txRetryTimeoutMs?: number;
	txSenderType?: 'fast' | 'retry' | 'while-valid' | 'jet';
	txSenderConfirmationStrategy: ConfirmationStrategy;
	txSkipPreflight?: boolean;
	txMaxRetries?: number;
	trackTxLandRate?: boolean;
	jetTxEndpoints?: string[];

	rebalanceFiller?: boolean;

	lutPubkey?: string;
}

export interface Config {
	global: GlobalConfig;
	enabledBots: Array<keyof BotConfigMap>;
	botConfigs?: BotConfigMap;
}

const defaultConfig: Partial<Config> = {
	global: {
		driftEnv: (process.env.ENV ?? 'devnet') as DriftEnv,
		initUser: false,
		testLiveness: false,
		cancelOpenOrders: false,
		closeOpenPositions: false,
		forceDeposit: null,
		websocket: false,
		eventSubscriber: false,
		runOnce: false,
		debug: false,
		subaccounts: [0],

		perpMarketsToLoad: parsePositiveIntArray(process.env.PERP_MARKETS_TO_LOAD),
		spotMarketsToLoad: parsePositiveIntArray(process.env.SPOT_MARKETS_TO_LOAD),

		eventSubscriberPollingInterval: 5000,
		bulkAccountLoaderPollingInterval: 5000,

		endpoint: process.env.ENDPOINT!,
		hermesEndpoint: process.env.HERMES_ENDPOINT,
		wsEndpoint: process.env.WS_ENDPOINT,
		heliusEndpoint: process.env.HELIUS_ENDPOINT,
		additionalSendTxEndpoints: [],
		txConfirmationEndpoint: process.env.TX_CONFIRMATION_ENDPOINT,
		priorityFeeMethod: process.env.PRIORITY_FEE_METHOD ?? 'solana',
		maxPriorityFeeMicroLamports: parseInt(
			process.env.MAX_PRIORITY_FEE_MICRO_LAMPORTS ?? '1000000'
		),
		priorityFeeMultiplier: 1.0,
		keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY,

		useJito: false,
		jitoStrategy: 'jito-only',
		jitoMinBundleTip: 10_000,
		jitoMaxBundleTip: 100_000,
		jitoMaxBundleFailCount: 200,
		jitoTipMultiplier: 3,
		jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL,
		jitoAuthPrivateKey: process.env.JITO_AUTH_PRIVATE_KEY,
		txRetryTimeoutMs: parseInt(process.env.TX_RETRY_TIMEOUT_MS ?? '30000'),
		onlySendDuringJitoLeader: false,
		txSkipPreflight: false,
		txMaxRetries: 0,
		txSenderConfirmationStrategy: ConfirmationStrategy.Combo,

		metricsPort: 9464,
		disableMetrics: false,

		rebalanceFiller: false,
	},
	enabledBots: [],
	botConfigs: {},
};

function mergeDefaults<T>(defaults: T, data: Partial<T>): T {
	const result: T = { ...defaults } as T;

	for (const key in data) {
		const value = data[key];

		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value === 'object' && !Array.isArray(value)) {
			result[key] = mergeDefaults(
				result[key],
				value as Partial<T[Extract<keyof T, string>]>
			);
		} else if (Array.isArray(value)) {
			if (!Array.isArray(result[key])) {
				result[key] = [] as any;
			}

			for (let i = 0; i < value.length; i++) {
				if (typeof value[i] === 'object' && !Array.isArray(value[i])) {
					const existingObj = (result[key] as unknown as any[])[i] || {};
					(result[key] as unknown as any[])[i] = mergeDefaults(
						existingObj,
						value[i]
					);
				} else {
					(result[key] as unknown as any[])[i] = value[i];
				}
			}
		} else {
			result[key] = value as T[Extract<keyof T, string>];
		}
	}

	return result;
}

export function loadConfigFromFile(path: string): Config {
	if (!path.endsWith('.yaml') && !path.endsWith('.yml')) {
		throw new Error('Config file must be a yaml file');
	}

	const configFile = fs.readFileSync(path, 'utf8');
	const config = YAML.parse(configFile) as Partial<Config>;

	return mergeDefaults(defaultConfig, config) as Config;
}

/**
 * For backwards compatibility, we allow the user to specify the config via command line arguments.
 * @param opts from program.opts()
 * @returns
 */
export function loadConfigFromOpts(opts: any): Config {
	const config: Config = {
		global: {
			driftEnv: (process.env.ENV ?? 'devnet') as DriftEnv,
			endpoint: opts.endpoint ?? process.env.ENDPOINT,
			wsEndpoint: opts.wsEndpoint ?? process.env.WS_ENDPOINT,
			hermesEndpoint: opts.hermesEndpoint ?? process.env.HERMES_ENDPOINT,
			heliusEndpoint: opts.heliusEndpoint ?? process.env.HELIUS_ENDPOINT,
			additionalSendTxEndpoints: loadCommaDelimitToStringArray(
				opts.additionalSendTxEndpoints
			),
			txConfirmationEndpoint:
				opts.txConfirmationEndpoint ?? process.env.TX_CONFIRMATION_ENDPOINT,
			priorityFeeMethod:
				opts.priorityFeeMethod ?? process.env.PRIORITY_FEE_METHOD,
			maxPriorityFeeMicroLamports: parseInt(
				opts.maxPriorityFeeMicroLamports ??
					process.env.MAX_PRIORITY_FEE_MICRO_LAMPORTS ??
					'1000000'
			),
			priorityFeeMultiplier: parseFloat(opts.priorityFeeMultiplier ?? '1.0'),
			keeperPrivateKey: opts.privateKey ?? process.env.KEEPER_PRIVATE_KEY,
			eventSubscriberPollingInterval: parseInt(
				process.env.BULK_ACCOUNT_LOADER_POLLING_INTERVAL ?? '5000'
			),
			bulkAccountLoaderPollingInterval: parseInt(
				process.env.EVENT_SUBSCRIBER_POLLING_INTERVAL ?? '5000'
			),
			initUser: opts.initUser ?? false,
			testLiveness: opts.testLiveness ?? false,
			cancelOpenOrders: opts.cancelOpenOrders ?? false,
			closeOpenPositions: opts.closeOpenPositions ?? false,
			forceDeposit: opts.forceDeposit ?? null,
			websocket: opts.websocket ?? false,
			eventSubscriber: opts.eventSubscriber ?? false,
			runOnce: opts.runOnce ?? false,
			debug: opts.debug ?? false,
			subaccounts: loadCommaDelimitToArray(opts.subaccount),
			useJito: opts.useJito ?? false,
			jitoStrategy: opts.jitoStrategy ?? 'exclusive',
			jitoMinBundleTip: opts.jitoMinBundleTip ?? 10_000,
			jitoMaxBundleTip: opts.jitoMaxBundleTip ?? 100_000,
			jitoMaxBundleFailCount: opts.jitoMaxBundleFailCount ?? 200,
			jitoTipMultiplier: opts.jitoTipMultiplier ?? 3,
			txRetryTimeoutMs: parseInt(opts.txRetryTimeoutMs ?? '30000'),
			txSenderType: opts.txSenderType ?? 'fast',
			txSkipPreflight: opts.txSkipPreflight
				? opts.txSkipPreflight.toLowerCase() === 'true'
				: false,
			txMaxRetries: parseInt(opts.txMaxRetries ?? '0'),
			trackTxLandRate: opts.trackTxLandRate ?? false,
			txSenderConfirmationStrategy:
				opts.txSenderConfirmationStrategy ?? ConfirmationStrategy.Combo,

			metricsPort: opts.metricsPort ?? 9464,
			disableMetrics: opts.disableMetrics ?? false,

			rebalanceFiller: opts.rebalanceFiller ?? false,
		},
		enabledBots: [],
		botConfigs: {},
	};

	if (opts.filler) {
		config.enabledBots.push('filler');
		config.botConfigs!.filler = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'filler',
			fillerPollingInterval: 5000,
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
			simulateTxForCUEstimate: opts.simulateTxForCUEstimate ?? true,
			rebalanceFiller: opts.rebalanceFiller ?? false,
			triggerPriorityFeeMultiplier: opts.triggerPriorityFeeMultiplier ?? 1.5,
		};
	}
	if (opts.fillerLite) {
		config.enabledBots.push('fillerLite');
		config.botConfigs!.fillerLite = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'fillerLite',
			fillerPollingInterval: 5000,
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
			simulateTxForCUEstimate: opts.simulateTxForCUEstimate ?? true,
			rebalanceFiller: opts.rebalanceFiller ?? false,
			triggerPriorityFeeMultiplier: opts.triggerPriorityFeeMultiplier ?? 1.5,
		};
	}
	if (opts.spotFiller) {
		config.enabledBots.push('spotFiller');
		config.botConfigs!.spotFiller = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'filler',
			fillerPollingInterval: 5000,
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
			simulateTxForCUEstimate: opts.simulateTxForCUEstimate ?? true,
			rebalanceFiller: opts.rebalanceFiller ?? false,
			triggerPriorityFeeMultiplier: opts.triggerPriorityFeeMultiplier ?? 1.5,
		};
	}
	if (opts.liquidator) {
		config.enabledBots.push('liquidator');
		config.botConfigs!.liquidator = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'liquidator',
			metricsPort: 9464,

			disableAutoDerisking: opts.disableAutoDerisking ?? false,
			perpMarketIndicies: loadCommaDelimitToArray(opts.perpMarketIndicies),
			spotMarketIndicies: loadCommaDelimitToArray(opts.spotMarketIndicies),
			runOnce: opts.runOnce ?? false,
			// deprecated: use {@link LiquidatorConfig.maxSlippageBps}
			maxSlippagePct: opts.maxSlippagePct ?? 50,
			maxSlippageBps: opts.maxSlippageBps ?? 50,
			deriskAuctionDurationSlots: opts.deriskAuctionDurationSlots ?? 100,
			twapDurationSec: parseInt(opts.twapDurationSec ?? '300'),
			notifyOnLiquidation: opts.notifyOnLiquidation ?? false,
		};
	}
	if (opts.trigger) {
		config.enabledBots.push('trigger');
		config.botConfigs!.trigger = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'trigger',
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
			triggerPriorityFeeMultiplier: opts.triggerPriorityFeeMultiplier ?? 1.5,
		};
	}
	if (opts.ifRevenueSettler) {
		config.enabledBots.push('ifRevenueSettler');
		config.botConfigs!.ifRevenueSettler = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'ifRevenueSettler',
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
		};
	}
	if (opts.userPnlSettler) {
		config.enabledBots.push('userPnlSettler');
		config.botConfigs!.userPnlSettler = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'userPnlSettler',
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
			perpMarketIndicies: loadCommaDelimitToArray(opts.perpMarketIndicies),
			settlePnlThresholdUsdc: Number(opts.settlePnlThresholdUsdc) ?? 10,
			maxUsersToConsider: Number(opts.maxUsersToConsider) ?? 50,
		};
	}
	if (opts.userIdleFlipper) {
		config.enabledBots.push('userIdleFlipper');
		config.botConfigs!.userIdleFlipper = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'userIdleFlipper',
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
		};
	}
	if (opts.fundingRateUpdater) {
		config.enabledBots.push('fundingRateUpdater');
		config.botConfigs!.fundingRateUpdater = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'fundingRateUpdater',
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
		};
	}

	if (opts.markTwapCrank) {
		config.enabledBots.push('markTwapCrank');
		config.botConfigs!.markTwapCrank = {
			dryRun: opts.dryRun ?? false,
			botId: process.env.BOT_ID ?? 'crank',
			metricsPort: 9464,
			runOnce: opts.runOnce ?? false,
		};
	}
	return mergeDefaults(defaultConfig, config) as Config;
}

export function configHasBot(
	config: Config,
	botName: keyof BotConfigMap
): boolean {
	const botEnabled = config.enabledBots.includes(botName) ?? false;
	const botConfigExists = config.botConfigs![botName] !== undefined;
	if (botEnabled && !botConfigExists) {
		throw new Error(
			`Bot ${botName} is enabled but no config was found for it.`
		);
	}
	return botEnabled && botConfigExists;
}

export const PULL_ORACLE_WHITELIST: {
	marketType: MarketType;
	marketIndex: number;
}[] = [
	{
		marketType: MarketType.PERP,
		marketIndex: 17,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 3,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 26,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 25,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 32,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 13,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 11,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 28,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 35,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 8,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 33,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 14,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 6,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 5,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 27,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 29,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 21,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 22,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 16,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 20,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 34,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 15,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 15,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 7,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 10,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 18,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 9,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 19,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 24,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 30,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 12,
	},
	{
		marketType: MarketType.PERP,
		marketIndex: 4,
	},
];

export const DEVNET_PULL_ORACLE_WHITELIST: {
	marketType: MarketType;
	marketIndex: number;
}[] = PerpMarkets['devnet'].map((mkt) => {
	return { marketType: MarketType.PERP, marketIndex: mkt.marketIndex };
});
