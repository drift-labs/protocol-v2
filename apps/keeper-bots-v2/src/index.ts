/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { program, Option } from 'commander';
import * as http from 'http';

import {
	Connection,
	Commitment,
	Keypair,
	PublicKey,
	TransactionVersion,
	ConfirmOptions,
} from '@solana/web3.js';

import { getAssociatedTokenAddress } from '@solana/spl-token';
import {
	BulkAccountLoader,
	DriftClient,
	initialize,
	EventSubscriber,
	SlotSubscriber,
	QUOTE_PRECISION,
	SpotMarkets,
	BN,
	TokenFaucet,
	DriftClientSubscriptionConfig,
	LogProviderConfig,
	FastSingleTxSender,
	UserMap,
	Wallet,
	RetryTxSender,
	PriorityFeeSubscriber,
	PriorityFeeMethod,
	HeliusPriorityFeeResponse,
	HeliusPriorityLevel,
	AverageOverSlotsStrategy,
	BlockhashSubscriber,
	WhileValidTxSender,
	configs,
	AuctionSubscriber,
	SwiftOrderSubscriber,
} from '@drift-labs/sdk';
import { promiseTimeout } from '@drift-labs/sdk';

import { logger, setLogLevel } from './logger';
import { constants } from './types';
import { FillerBot } from './bots/filler';
import { SpotFillerBot } from './bots/spotFiller';
import { TriggerBot } from './bots/trigger';
import { LiquidatorBot } from './bots/liquidator';
import { FloatingPerpMakerBot } from './bots/floatingMaker';
import { Bot } from './types';
import { IFRevenueSettlerBot } from './bots/ifRevenueSettler';
import { UserPnlSettlerBot } from './bots/userPnlSettler';
import { UserIdleFlipperBot } from './bots/userIdleFlipper';
import {
	getOrCreateAssociatedTokenAccount,
	sleepMs,
	TOKEN_FAUCET_PROGRAM_ID,
	getWallet,
	loadKeypair,
	getMarketsAndOracleInfosToLoad,
} from './utils';
import {
	Config,
	configHasBot,
	loadConfigFromFile,
	loadConfigFromOpts,
} from './config';
import { FundingRateUpdaterBot } from './bots/fundingRateUpdater';
import { FillerLiteBot } from './bots/fillerLite';
import { MakerBidAskTwapCrank } from './bots/makerBidAskTwapCrank';
import { BundleSender } from './bundleSender';
import { DriftStateWatcher, StateChecks } from './driftStateWatcher';
import { webhookMessage } from './webhook';
import { SwitchboardCrankerBot } from './bots/switchboardCranker';
import { PythLazerCrankerBot } from './bots/pythLazerCranker';
import { JitMaker } from './bots/jitMaker';
import { JitProxyClient, JitterSniper } from '@drift-labs/jit-proxy/lib';
import { JetProxyTxSender } from './bots/common/jetTxSender';
import { Agent, setGlobalDispatcher } from 'undici';
import { timedCacheableLookup } from './bots/common/timedLookup';

require('dotenv').config();
const commitHash = process.env.COMMIT ?? '';

const stateCommitment = (process.env.STATE_COMMITMENT ??
	'confirmed') as Commitment;
const healthCheckPort = process.env.HEALTH_CHECK_PORT || 8888;

program
	.option('-d, --dry-run', 'Dry run, do not send transactions on chain')
	.option(
		'--init-user',
		'calls driftClient.initializeUserAccount if no user account exists'
	)
	.option('--filler', 'Enable filler bot')
	.option('--filler-lite', 'Enable filler lite bot')
	.option('--spot-filler', 'Enable spot filler bot')
	.option('--trigger', 'Enable trigger bot')
	.option('--jit-maker', 'Enable JIT auction maker bot')
	.option('--floating-maker', 'Enable floating maker bot')
	.option('--liquidator', 'Enable liquidator bot')
	.option('--uncross-arb', 'Arb bot')
	.option(
		'--if-revenue-settler',
		'Enable Insurance Fund revenue pool settler bot'
	)
	.option('--funding-rate-updater', 'Enable Funding Rate updater bot')
	.option('--user-pnl-settler', 'Enable User PnL settler bot')
	.option('--user-lp-settler', 'Settle active LP positions')
	.option('--user-idle-flipper', 'Flips eligible users to idle')
	.option('--mark-twap-crank', 'Enable bid/ask twap crank bot')
	.option('--test-liveness', 'Purposefully fail liveness test after 1 minute')
	.option(
		'--force-deposit <number>',
		'Force deposit this amount of USDC to collateral account, the program will end after the deposit transaction is sent'
	)
	.option('--metrics <number>', 'Enable Prometheus metric scraper (deprecated)')
	.addOption(
		new Option(
			'-p, --private-key <string>',
			'private key, supports path to id.json, or list of comma separate numbers'
		).env('KEEPER_PRIVATE_KEY')
	)
	.option('--debug', 'Enable debug logging')
	.option(
		'--run-once',
		'Exit after running bot loops once (only for supported bots)'
	)
	.option(
		'--additional-send-tx-endpoints <string>',
		'Additional RPC endpoints to send transactions to (comma delimited)'
	)
	.option(
		'--websocket',
		'Use websocket instead of RPC polling for account updates'
	)
	.option(
		'--disable-auto-derisking',
		'Set to disable auto derisking (primarily used for liquidator to close inherited positions)'
	)
	.option(
		'--subaccount <string>',
		'subaccount(s) to use (comma delimited), specify which subaccountsIDs to load',
		'0'
	)
	.option(
		'--perp-market-indicies <string>',
		'comma delimited list of perp market index(s) for applicable bots (willing to inherit risk), omit for all',
		''
	)
	.option(
		'--spot-markets-indicies <string>',
		'comma delimited list of spot market index(s) for applicable bots (willing to inherit risk), omit for all',
		''
	)
	.option(
		'--config-file <string>',
		'Config file to load (yaml format), will override any other config options',
		''
	)
	.option(
		'--use-jito',
		'Submit transactions to a Jito relayer if the bot supports it'
	)
	.option(
		'--event-susbcriber',
		'Explicitly intialize an eventSubscriber (RPC heavy)'
	)
	.option(
		'--tx-sender-type <string>',
		'Transaction sender type. Valid options: fast, retry, while-valid'
	)
	.option(
		'--tx-max-retries <number>',
		'Override maxRetries param when sending transactions'
	)
	.option(
		'--tx-skip-preflight <string>',
		'Value to set for skipPreflight when sending transactions. Valid options: true, false'
	)
	.option(
		'--tx-retry-timeout-ms <string>',
		'Timeout in ms for retry tx sender',
		'30000'
	)
	.option(
		'--market-type <type>',
		'Set the market type for the JIT Maker bot',
		'PERP'
	)
	.option(
		'--priority-fee-multiplier <number>',
		'Multiplier for the priority fee',
		'1.0'
	)
	.option('--metrics-port <number>', 'Port for the Prometheus exporter', '9464')
	.option('--disable-metrics', 'Set to disable Prometheus metrics')
	.option(
		'--settle-pnl-threshold-usdc <number>',
		'Settle PnL if above this threshold (USDC)',
		'100'
	)
	.option(
		'--max-users-to-consider <number>',
		'Max number of users to consider for settling pnl in each iteration',
		'50'
	)
	.parse();

const opts = program.opts();
let config: Config;
if (opts.configFile) {
	logger.info(`Loading config from ${opts.configFile}`);
	config = loadConfigFromFile(opts.configFile);
} else {
	logger.info(`Loading config from command line options`);
	config = loadConfigFromOpts(opts);
}
logger.info(
	`Bot config:\n${JSON.stringify(
		config,
		(k, v) => {
			if (k === 'keeperPrivateKey') {
				return '*'.repeat(v.length);
			}
			return v;
		},
		2
	)}`
);

// @ts-ignore
const sdkConfig = initialize({ env: config.global.driftEnv });
const agent = new Agent({
	connections: 200,
	allowH2: false,
	keepAliveTimeout: 60_000,
	connect: { lookup: timedCacheableLookup },
});

setGlobalDispatcher(agent);
setLogLevel(config.global.debug ? 'debug' : 'info');

const endpoint = config.global.endpoint!;
const wsEndpoint = config.global.wsEndpoint;
const heliusEndpoint = config.global.heliusEndpoint;
const jetTxEndpoints = config.global.jetTxEndpoints;
logger.info(`RPC endpoint: ${endpoint}`);
logger.info(`WS endpoint:  ${wsEndpoint}`);
logger.info(`Helius endpoint:  ${heliusEndpoint}`);
logger.info(`DriftEnv:     ${config.global.driftEnv}`);
logger.info(`Commit:       ${commitHash}`);

const bots: Bot[] = [];
const runBot = async () => {
	logger.info(`Loading wallet keypair`);
	const privateKeyOrFilepath = config.global.keeperPrivateKey;
	if (!privateKeyOrFilepath) {
		throw new Error(
			'Must set environment variable KEEPER_PRIVATE_KEY with the path to a id.json or a list of commma separated numbers'
		);
	}
	const [keypair, wallet] = getWallet(privateKeyOrFilepath);
	const driftPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const connection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
	});

	let bulkAccountLoader: BulkAccountLoader | undefined;
	let lastBulkAccountLoaderSlot: number | undefined;
	let accountSubscription: DriftClientSubscriptionConfig = {
		type: 'websocket',
		resubTimeoutMs: config.global.resubTimeoutMs,
	};
	let logProviderConfig: LogProviderConfig = {
		type: 'websocket',
	};
	let userMapSubscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
				commitment?: Commitment;
		  }
		| {
				type: 'websocket';
				resubTimeoutMs?: number;
				commitment?: Commitment;
		  } = {
		type: 'websocket',
		resubTimeoutMs: 30_000,
		commitment: stateCommitment,
	};

	if (!config.global.websocket) {
		const bulkAccountLoaderConnection = new Connection(endpoint, {
			wsEndpoint: wsEndpoint,
			commitment: stateCommitment,
			disableRetryOnRateLimit: true,
		});
		bulkAccountLoader = new BulkAccountLoader(
			bulkAccountLoaderConnection,
			stateCommitment,
			config.global.bulkAccountLoaderPollingInterval
		);
		lastBulkAccountLoaderSlot = bulkAccountLoader.mostRecentSlot;
		accountSubscription = {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		};
		logProviderConfig = {
			type: 'polling',
			frequency: config.global.eventSubscriberPollingInterval,
		};
		userMapSubscriptionConfig = {
			type: 'polling',
			frequency: 15_000, // reasonable refresh time since userMap calls getProgramAccounts to update.
			commitment: stateCommitment,
		};
	}

	const opts: ConfirmOptions = {
		commitment: stateCommitment,
		skipPreflight: config.global.txSkipPreflight,
		preflightCommitment: stateCommitment,
		maxRetries: config.global.txMaxRetries,
	};
	const sendTxConnection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
		disableRetryOnRateLimit: true,
	});

	const txSenderType = config.global.txSenderType || 'retry';
	let txSender: FastSingleTxSender | RetryTxSender | WhileValidTxSender;
	const confirmationStrategy = config.global.txSenderConfirmationStrategy;
	let additionalConnections: Connection[] = [];
	if (
		config.global.additionalSendTxEndpoints &&
		config.global.additionalSendTxEndpoints.length > 0
	) {
		additionalConnections = config.global.additionalSendTxEndpoints.map(
			(endpoint) => new Connection(endpoint)
		);
	}
	if (txSenderType === 'retry') {
		txSender = new RetryTxSender({
			connection: sendTxConnection,
			wallet,
			opts,
			retrySleep: 8000,
			timeout: config.global.txRetryTimeoutMs,
			confirmationStrategy,
			additionalConnections,
			trackTxLandRate: config.global.trackTxLandRate,
			throwOnTimeoutError: false,
		});
	} else if (txSenderType === 'while-valid') {
		txSender = new WhileValidTxSender({
			connection: sendTxConnection,
			wallet,
			opts,
			retrySleep: 2000,
			additionalConnections,
			confirmationStrategy,
			trackTxLandRate: config.global.trackTxLandRate,
			throwOnTimeoutError: false,
		});
	} else if (txSenderType === 'jet') {
		const endpoints = jetTxEndpoints ?? [endpoint];
		const submitConnections = endpoints.map(
			(ep) =>
				new Connection(ep, {
					wsEndpoint: wsEndpoint,
					commitment: stateCommitment,
					disableRetryOnRateLimit: true,
				})
		);

		txSender = new JetProxyTxSender({
			connection: sendTxConnection,
			submitConnections,
			wallet,
			opts,
			retrySleep: 2000,
			additionalConnections,
			confirmationStrategy,
			trackTxLandRate: config.global.trackTxLandRate,
			throwOnTimeoutError: false,
		});
	} else {
		const skipConfirmation =
			configHasBot(config, 'fillerLite') ||
			configHasBot(config, 'filler') ||
			configHasBot(config, 'spotFiller') ||
			configHasBot(config, 'liquidator') ||
			configHasBot(config, 'pythLazerCranker');
		txSender = new FastSingleTxSender({
			connection: sendTxConnection,
			blockhashRefreshInterval: 500,
			wallet,
			opts,
			skipConfirmation,
			additionalConnections,
			trackTxLandRate: config.global.trackTxLandRate,
			throwOnTimeoutError: false,
		});
	}

	/**
	 * Creating and subscribing to the drift client
	 */

	// keeping these arrays undefined will prompt DriftClient to call `findAllMarketAndOracles`
	// and load all markets and oracle accounts from on-chain
	const marketLookupTables = configs[
		config.global.driftEnv!
	].MARKET_LOOKUP_TABLES.map((key) => new PublicKey(key));
	const marketsAndOracleInfos = getMarketsAndOracleInfosToLoad(
		sdkConfig,
		config.global.perpMarketsToLoad,
		config.global.spotMarketsToLoad
	);
	const oracleInfos = marketsAndOracleInfos.oracleInfos;
	const driftClientConfig = {
		connection,
		wallet,
		programID: driftPublicKey,
		opts,
		accountSubscription,
		env: config.global.driftEnv,
		userStats: true,
		perpMarketIndexes: marketsAndOracleInfos.perpMarketIndicies,
		spotMarketIndexes: marketsAndOracleInfos.spotMarketIndicies,
		oracleInfos: oracleInfos.length > 0 ? oracleInfos : undefined,
		activeSubAccountId: config.global.subaccounts![0],
		subAccountIds: config.global.subaccounts ?? [0],
		txVersion: 0 as TransactionVersion,
		txSender,
		marketLookupTables,
	};
	const driftClient = new DriftClient(driftClientConfig);
	driftClient.eventEmitter.on('error', (e) => {
		logger.info('clearing house error');
		logger.error(e);
	});

	let eventSubscriber: EventSubscriber | undefined = undefined;
	if (config.global.eventSubscriber) {
		eventSubscriber = new EventSubscriber(connection, driftClient.program, {
			maxTx: 4096,
			maxEventsPerType: 4096,
			orderBy: 'blockchain', // Possible options are 'blockchain' or 'client'
			orderDir: 'desc',
			commitment: stateCommitment,
			logProviderConfig,
		});
	}

	const slotSubscriber = new SlotSubscriber(connection, {});
	await slotSubscriber.subscribe();

	const startupTime = Date.now();
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	logger.info(
		`DriftClient ProgramId: ${driftClient.program.programId.toBase58()}`
	);
	logger.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	logger.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);

	try {
		const tokenAccount = await getOrCreateAssociatedTokenAccount(
			connection,
			new PublicKey(constants[config.global.driftEnv!].USDCMint),
			wallet
		);
		const usdcBalance = await connection.getTokenAccountBalance(tokenAccount);
		logger.info(` . USDC balance: ${usdcBalance.value.uiAmount}`);
	} catch (e) {
		logger.info(`Failed to load USDC token account: ${e}`);
	}

	/**
	 * Jito info here
	 */
	let bundleSender: BundleSender | undefined;
	let jitoAuthKeypair: Keypair | undefined;
	if (config.global.useJito) {
		const jitoBlockEngineUrl = config.global.jitoBlockEngineUrl;
		const privateKey = config.global.jitoAuthPrivateKey;
		if (!jitoBlockEngineUrl) {
			throw new Error(
				'Must configure or set JITO_BLOCK_ENGINE_URL environment variable '
			);
		}
		if (!privateKey) {
			throw new Error(
				'Must configure or set JITO_AUTH_PRIVATE_KEY environment variable'
			);
		}
		logger.info(`Loading jito keypair`);
		jitoAuthKeypair = loadKeypair(privateKey);

		bundleSender = new BundleSender(
			connection,
			jitoBlockEngineUrl,
			jitoAuthKeypair,
			keypair,
			slotSubscriber,
			config.global.jitoStrategy,
			config.global.jitoMinBundleTip,
			config.global.jitoMaxBundleTip,
			config.global.jitoMaxBundleFailCount,
			config.global.jitoTipMultiplier
		);
		await bundleSender.subscribe();
	}

	/*
	 * Start bots depending on flags enabled
	 */
	let needPythPriceSubscriber = false;
	let needCheckDriftUser = false;
	let needForceCollateral = !!config.global.forceDeposit;
	let needUserMapSubscribe = false;
	const userMapConnection = new Connection(endpoint);
	const userMap = new UserMap({
		driftClient,
		connection: userMapConnection,
		subscriptionConfig: userMapSubscriptionConfig,
		skipInitialLoad: false,
		includeIdle: false,
	});

	let needPriorityFeeSubscriber = false;
	const priorityFeeMethod =
		(config.global.priorityFeeMethod as PriorityFeeMethod) ??
		PriorityFeeMethod.SOLANA;
	const priorityFeeSubscriber = new PriorityFeeSubscriber({
		connection: driftClient.connection,
		frequencyMs: 5000,
		customStrategy:
			priorityFeeMethod === PriorityFeeMethod.HELIUS
				? {
						calculate: (samples: HeliusPriorityFeeResponse) => {
							return samples.result.priorityFeeLevels![
								HeliusPriorityLevel.HIGH
							];
						},
				  }
				: new AverageOverSlotsStrategy(),
		// the specific bot will update this, if multiple bots are using this,
		// the last one to update it will determine the addresses to use...
		addresses: [],
		heliusRpcUrl: heliusEndpoint,
		priorityFeeMethod,
		maxFeeMicroLamports: config.global.maxPriorityFeeMicroLamports,
		priorityFeeMultiplier: config.global.priorityFeeMultiplier ?? 1.0,
	});
	logger.info(
		`priorityFeeMethod: ${priorityFeeSubscriber.priorityFeeMethod}, maxFeeMicroLamports: ${priorityFeeSubscriber.maxFeeMicroLamports}, method: ${priorityFeeSubscriber.priorityFeeMethod}`
	);

	let needBlockhashSubscriber = false;
	const blockhashSubscriber = new BlockhashSubscriber({
		connection: driftClient.connection,
		updateIntervalMs: 2000,
	});

	let needDriftStateWatcher = false;
	let needDriftClient = false;

	if (configHasBot(config, 'pythLazerCranker')) {
		needPriorityFeeSubscriber = true;
		needDriftClient = true;

		bots.push(
			new PythLazerCrankerBot(
				config.global,
				config.botConfigs!.pythLazerCranker!,
				driftClient,
				priorityFeeSubscriber,
				[]
			)
		);
	}
	if (configHasBot(config, 'switchboardCranker')) {
		needPriorityFeeSubscriber = true;
		needDriftStateWatcher = true;

		bots.push(
			new SwitchboardCrankerBot(
				config.global,
				config.botConfigs!.switchboardCranker!,
				driftClient,
				priorityFeeSubscriber,
				bundleSender,
				[]
			)
		);
	}

	if (configHasBot(config, 'jitMaker')) {
		needPriorityFeeSubscriber = true;
		needDriftStateWatcher = true;
		needUserMapSubscribe = true;

		const auctionSubscriber = new AuctionSubscriber({
			driftClient,
			resubTimeoutMs: 30_000,
		});
		let swiftOrderSubscriber: SwiftOrderSubscriber | undefined = undefined;
		if (config.global.driftEnv === 'devnet') {
			if (!config.botConfigs?.jitMaker?.marketIndexes) {
				throw new Error('Market indexes must be specified for JIT Maker bot');
			}
			swiftOrderSubscriber = new SwiftOrderSubscriber({
				driftEnv: 'devnet',
				marketIndexes: config.botConfigs?.jitMaker?.marketIndexes,
				keypair: new Keypair(),
				driftClient,
				userAccountGetter: userMap,
			});
		}

		const jitProxyClient = new JitProxyClient({
			// @ts-ignore
			driftClient,
			programId: new PublicKey(sdkConfig.JIT_PROXY_PROGRAM_ID!),
		});

		// Cast to any to work around SDK version mismatch between jit-proxy and main SDK
		const jitter = new JitterSniper({
			auctionSubscriber: auctionSubscriber as any,
			driftClient: driftClient as any,
			jitProxyClient,
			swiftOrderSubscriber: swiftOrderSubscriber as any,
			slotSubscriber: slotSubscriber as any,
			auctionSubscriberIgnoresSwiftOrders: !!swiftOrderSubscriber,
		});
		await jitter.subscribe();

		bots.push(
			new JitMaker(
				driftClient,
				jitter,
				config.botConfigs!.jitMaker!,
				config.global.driftEnv,
				priorityFeeSubscriber
			)
		);
	}

	if (configHasBot(config, 'filler')) {
		needPythPriceSubscriber = true;
		needCheckDriftUser = true;
		needUserMapSubscribe = true;
		needPriorityFeeSubscriber = true;
		needBlockhashSubscriber = true;
		needDriftStateWatcher = true;

		bots.push(
			new FillerBot(
				slotSubscriber,
				bulkAccountLoader,
				driftClient,
				userMap,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv!,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.global,
				config.botConfigs!.filler!,
				priorityFeeSubscriber,
				blockhashSubscriber,
				bundleSender,
				[]
			)
		);
	}

	if (configHasBot(config, 'fillerLite')) {
		needPythPriceSubscriber = true;
		needCheckDriftUser = true;
		needPriorityFeeSubscriber = true;
		needBlockhashSubscriber = true;
		needDriftStateWatcher = true;

		logger.info(`Starting filler lite bot`);
		bots.push(
			new FillerLiteBot(
				slotSubscriber,
				driftClient,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv!,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.global,
				config.botConfigs!.fillerLite!,
				priorityFeeSubscriber,
				blockhashSubscriber,
				bundleSender,
				[]
			)
		);
	}

	if (configHasBot(config, 'spotFiller')) {
		needCheckDriftUser = true;
		// to avoid long startup, spotFiller will fetch userAccounts as needed and build the map over time
		needUserMapSubscribe = false;
		needPriorityFeeSubscriber = true;
		needBlockhashSubscriber = true;
		needDriftStateWatcher = true;

		bots.push(
			new SpotFillerBot(
				driftClient,
				userMap,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv!,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.global,
				config.botConfigs!.spotFiller!,
				priorityFeeSubscriber,
				blockhashSubscriber,
				bundleSender,
				[]
			)
		);
	}

	if (configHasBot(config, 'trigger')) {
		needUserMapSubscribe = true;
		needDriftStateWatcher = true;
		needBlockhashSubscriber = true;

		bots.push(
			new TriggerBot(
				driftClient,
				slotSubscriber,
				blockhashSubscriber,
				userMap,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv!,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs!.trigger!,
				config.global,
				priorityFeeSubscriber
			)
		);
	}

	if (configHasBot(config, 'liquidator')) {
		needCheckDriftUser = true;
		needUserMapSubscribe = true;
		needForceCollateral = true;
		needPriorityFeeSubscriber = true;
		needDriftStateWatcher = true;

		bots.push(
			new LiquidatorBot(
				driftClient,
				userMap,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv!,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs!.liquidator!,
				config.global.subaccounts![0],
				priorityFeeSubscriber,
				sdkConfig.SERUM_LOOKUP_TABLE
					? new PublicKey(sdkConfig.SERUM_LOOKUP_TABLE as string)
					: undefined
			)
		);
	}

	if (configHasBot(config, 'floatingMaker')) {
		needCheckDriftUser = true;
		bots.push(
			new FloatingPerpMakerBot(
				driftClient,
				slotSubscriber,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv!,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs!.floatingMaker!
			)
		);
	}

	if (configHasBot(config, 'userPnlSettler')) {
		needDriftStateWatcher = true;
		needPriorityFeeSubscriber = true;
		bots.push(
			new UserPnlSettlerBot(
				driftClient,
				priorityFeeSubscriber,
				config.botConfigs!.userPnlSettler!,
				config.global
			)
		);
	}

	if (configHasBot(config, 'userIdleFlipper')) {
		needUserMapSubscribe = true;
		needBlockhashSubscriber = true;
		needDriftStateWatcher = true;

		bots.push(
			new UserIdleFlipperBot(
				driftClient,
				config.botConfigs!.userIdleFlipper!,
				blockhashSubscriber
			)
		);
	}

	if (configHasBot(config, 'ifRevenueSettler')) {
		needDriftStateWatcher = true;

		bots.push(
			new IFRevenueSettlerBot(driftClient, config.botConfigs!.ifRevenueSettler!)
		);
	}

	if (configHasBot(config, 'fundingRateUpdater')) {
		needCheckDriftUser = true;
		needDriftStateWatcher = true;

		bots.push(
			new FundingRateUpdaterBot(
				driftClient,
				config.botConfigs!.fundingRateUpdater!
			)
		);
	}

	if (configHasBot(config, 'markTwapCrank')) {
		needPythPriceSubscriber = true;
		needBlockhashSubscriber = true;
		needCheckDriftUser = true;
		needUserMapSubscribe = true;
		needDriftStateWatcher = true;

		bots.push(
			new MakerBidAskTwapCrank(
				driftClient,
				slotSubscriber,
				userMap,
				config.botConfigs!.markTwapCrank!,
				config.global,
				config.global.runOnce ?? false,
				blockhashSubscriber,
				[],
				bundleSender
			)
		);
	}

	// Run subscribe functions once
	if (
		needDriftClient ||
		needCheckDriftUser ||
		needForceCollateral ||
		eventSubscriber ||
		needUserMapSubscribe ||
		needPythPriceSubscriber ||
		needDriftStateWatcher
	) {
		const hrStart = process.hrtime();
		while (!(await driftClient.subscribe())) {
			logger.info('retrying driftClient.subscribe in 1s...');
			await sleepMs(1000);
		}
		const hrEnd = process.hrtime(hrStart);
		logger.info(`driftClient.subscribe took: ${hrEnd[0]}s ${hrEnd[1] / 1e6}ms`);
	}

	logger.info(`Checking user exists: ${needCheckDriftUser}`);
	if (needCheckDriftUser) await checkUserExists(config, driftClient, wallet);

	logger.info(`Checking if bot needs collateral: ${needForceCollateral}`);
	if (needForceCollateral)
		await checkAndForceCollateral(config, driftClient, wallet);

	logger.info(
		`Checking if need eventSubscriber: ${eventSubscriber !== undefined}`
	);
	if (eventSubscriber) await eventSubscriber.subscribe();

	logger.info(`Checking if need usermap: ${needUserMapSubscribe}`);
	if (needUserMapSubscribe) {
		const hrStart = process.hrtime();
		await userMap.subscribe();
		const hrEnd = process.hrtime(hrStart);
		logger.info(`userMap.subscribe took: ${hrEnd[0]}s ${hrEnd[1] / 1e6}ms`);
	}

	logger.info(
		`Checking if need PriorityFeeSubscriber: ${needPriorityFeeSubscriber}`
	);
	if (needPriorityFeeSubscriber) {
		const hrStart = process.hrtime();
		await priorityFeeSubscriber.subscribe();
		const hrEnd = process.hrtime(hrStart);
		logger.info(
			`priorityFeeSubscriber.subscribe() took: ${hrEnd[0]}s ${hrEnd[1] / 1e6}ms`
		);
	}
	if (needBlockhashSubscriber) {
		await blockhashSubscriber.subscribe();
	}

	const activeBots = bots.map((bot) => bot.name);

	let driftStateWatcher: DriftStateWatcher | undefined;
	if (needDriftStateWatcher) {
		driftStateWatcher = new DriftStateWatcher({
			driftClient,
			intervalMs: 10_000,
			stateChecks: {
				perpMarketStatus: true,
				spotMarketStatus: true,
				newPerpMarkets: true,
				newSpotMarkets: true,
				onStateChange: async (message: string, changes: StateChecks) => {
					const msg = `DriftStateWatcher triggered: ${message}]\nactive bots: ${JSON.stringify(
						activeBots
					)}\nstate changes: ${JSON.stringify(changes)}`;
					logger.info(msg);
					await webhookMessage(msg);
				},
			},
		});
		driftStateWatcher.subscribe();
	}

	if (bots.length === 0) {
		throw new Error(
			`No active bot specified. You must specify a bot through --config-file, or a cli arg. Check the README.md for more information`
		);
	}

	// Initialize bots
	logger.info(`initializing bots`);
	await Promise.all(bots.map((bot) => bot.init()));

	logger.info(
		`starting bots (runOnce: ${
			config.global.runOnce
		}), active bots: ${JSON.stringify(activeBots)}`
	);
	await Promise.all(
		bots.map((bot) => bot.startIntervalLoop(bot.defaultIntervalMs))
	);

	// start http server listening to /health endpoint using http package
	http
		.createServer(async (req, res) => {
			if (req.url === '/health') {
				if (config.global.testLiveness) {
					if (Date.now() > startupTime + 60 * 1000) {
						res.writeHead(500);
						res.end('Testing liveness test fail');
						return;
					}
				}

				if (config.global.websocket) {
					/* @ts-ignore */
					if (!driftClient.connection._rpcWebSocketConnected) {
						logger.error(`Connection rpc websocket disconnected`);
						res.writeHead(500);
						res.end(`Connection rpc websocket disconnected`);
						return;
					}
				}

				if (bulkAccountLoader) {
					// we expect health checks to happen at a rate slower than the BulkAccountLoader's polling frequency
					if (
						lastBulkAccountLoaderSlot &&
						bulkAccountLoader.mostRecentSlot === lastBulkAccountLoaderSlot
					) {
						res.writeHead(502);
						res.end(`bulkAccountLoader.mostRecentSlot is not healthy`);
						logger.error(
							`Health check failed due to stale bulkAccountLoader.mostRecentSlot`
						);
						return;
					}
					lastBulkAccountLoaderSlot = bulkAccountLoader.mostRecentSlot;
				}

				// check all bots if they're live
				for (const bot of bots) {
					const healthCheck = await promiseTimeout(bot.healthCheck(), 1000);
					if (!healthCheck) {
						logger.error(`Health check failed for bot ${bot.name}`);
						res.writeHead(503);
						res.end(`Bot ${bot.name} is not healthy`);
						return;
					}
				}

				if (driftStateWatcher && driftStateWatcher.triggered) {
					const triggeredStates = JSON.stringify(
						driftStateWatcher.triggeredStates
					);
					logger.error(
						`Health check failed for DriftStateWatcher, bot names: ${JSON.stringify(
							activeBots
						)}, state changes: ${triggeredStates}`
					);
					res.writeHead(503);
					res.end(
						`DriftStateWatcher is not healthy, triggeredStates: ${triggeredStates}`
					);
					return;
				}

				// liveness check passed
				res.writeHead(200);
				res.end('OK');
			} else {
				res.writeHead(404);
				res.end('Not found');
			}
		})
		.listen(healthCheckPort);
	logger.info(`Health check server listening on port ${healthCheckPort}`);

	if (config.global.runOnce) {
		process.exit(0);
	}
};

recursiveTryCatch(() => runBot());

async function recursiveTryCatch(f: () => void) {
	try {
		f();
	} catch (e) {
		console.error(e);
		for (const bot of bots) {
			bot.reset();
			await bot.init();
		}
		await sleepMs(15000);
		await recursiveTryCatch(f);
	}
}

async function checkUserExists(
	config: Config,
	driftClient: DriftClient,
	wallet: Wallet
) {
	if (!(await driftClient.getUser().exists())) {
		logger.error(
			`User for ${wallet.publicKey} does not exist (subAccountId: ${driftClient.activeSubAccountId})`
		);
		if (config.global.initUser) {
			logger.info(`Creating User for ${wallet.publicKey}`);
			const [txSig] = await driftClient.initializeUserAccount();
			logger.info(`Initialized user account in transaction: ${txSig}`);
		} else {
			throw new Error("Run with '--init-user' flag to initialize a User");
		}
	}
	return true;
}

async function checkAndForceCollateral(
	config: Config,
	driftClient: DriftClient,
	wallet: Wallet
) {
	// Force depost collateral if requested
	if (config.global.forceDeposit) {
		logger.info(
			`Depositing (${new BN(
				config.global.forceDeposit
			).toString()} USDC to collateral account)`
		);

		if (config.global.forceDeposit < 0) {
			logger.error(`Deposit amount must be greater than 0`);
			throw new Error('Deposit amount must be greater than 0');
		}

		const mint = SpotMarkets[config.global.driftEnv!][0].mint; // TODO: are index 0 always USDC???, support other collaterals
		const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
		const amount = new BN(config.global.forceDeposit).mul(QUOTE_PRECISION);

		if (config.global.driftEnv === 'devnet') {
			const tokenFaucet = new TokenFaucet(
				driftClient.connection,
				wallet,
				TOKEN_FAUCET_PROGRAM_ID,
				mint,
				opts
			);
			await tokenFaucet.mintToUser(ata, amount);
		}
		const tx = await driftClient.deposit(
			amount,
			0, // USDC bank
			ata
		);
		logger.info(`Deposit transaction: ${tx}`);
		logger.info(`exiting...run again without --force-deposit flag`);
	}
	return true;
}
