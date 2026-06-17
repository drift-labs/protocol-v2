import { program } from 'commander';

import { Connection, Commitment, PublicKey, Keypair } from '@solana/web3.js';

import {
	DriftClient,
	initialize,
	DriftEnv,
	SlotSubscriber,
	Wallet,
	EventSubscriber,
	OrderAction,
	convertToNumber,
	BASE_PRECISION,
	QUOTE_PRECISION,
	PRICE_PRECISION,
	getVariant,
	ZERO,
	BN,
	OrderActionRecord,
	Event,
} from '@velocity-exchange/sdk';
import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';
import express from 'express';

import { Metrics } from '../core/metricsV2';
import { logger, setLogLevel } from '../utils/logger';
import { sleep } from '../utils/utils';
import {
	createTradeMetricsProcessor,
	FillEvent,
} from './tradeMetricsProcessor';
import { fromEvent, filter, map } from 'rxjs';
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(
	new Agent({
		connections: 200,
	})
);

require('dotenv').config();
const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const commitHash = process.env.COMMIT;
const REDIS_CLIENT = process.env.REDIS_CLIENT || 'DLOB';
const metricsPort = process.env.METRICS_PORT
	? parseInt(process.env.METRICS_PORT)
	: 9464;
const indicativeQuoteMaxAgeMs = process.env.INDICATIVE_QUOTES_MAX_AGE_MS
	? parseInt(process.env.INDICATIVE_QUOTES_MAX_AGE_MS)
	: 1000;
console.log('Redis Clients:', REDIS_CLIENT);
const redisClientPrefix = RedisClientPrefix[REDIS_CLIENT];
//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });

const stateCommitment: Commitment = 'confirmed';
let driftClient: DriftClient;

const metricsV2 = new Metrics('trades-publisher', undefined, metricsPort);
const marketFillCount = metricsV2.addCounter(
	'market_fill_count',
	'Total market fills considered for indicative quote metrics'
);
const indicativePresenceCount = metricsV2.addCounter(
	'indicative_presence_total',
	'Count of fills where a maker had any fresh indicative quote on the relevant side'
);
const indicativeCompetitiveOpportunityCount = metricsV2.addCounter(
	'indicative_competitive_opportunity_total',
	'Count of market fills where a maker had a fresh competitive indicative quote'
);
const indicativeCompetitiveFillCount = metricsV2.addCounter(
	'indicative_competitive_fill_total',
	'Count of competitive opportunities where the maker captured the fill'
);
const indicativeCompetitiveOpportunityNotional = metricsV2.addCounter(
	'indicative_competitive_opportunity_notional_total',
	'Total competitive opportunity notional in quote units for each maker'
);
const indicativeCompetitiveCapturedNotional = metricsV2.addCounter(
	'indicative_competitive_captured_notional_total',
	'Total captured notional in quote units on competitive opportunities for each maker'
);
const indicativeFillVsQuoteOutcomeCount = metricsV2.addCounter(
	'indicative_fill_vs_quote_outcome_total',
	'Count of maker fills by weighted fresh indicative quote bucket and direction'
);
const indicativeTotalSizeOnBookGauge = metricsV2.addGauge(
	'indicative_total_size_on_book',
	'Latest fresh total quoted value on book by maker, market, and side'
);
const indicativeCompetitiveSizeOnBookGauge = metricsV2.addGauge(
	'indicative_competitive_size_on_book',
	'Latest fresh competitive quoted value on book by maker, market, and side'
);
metricsV2.finalizeObservables();

const opts = program.opts();
setLogLevel(opts.debug ? 'debug' : 'info');

const endpoint = process.env.ENDPOINT;
const wsEndpoint = process.env.WS_ENDPOINT;
const indicativeQuotesCacheTtlMs = process.env.INDICATIVE_QUOTES_CACHE_TTL_MS
	? parseInt(process.env.INDICATIVE_QUOTES_CACHE_TTL_MS)
	: 250;
const indicativeToMakerAuthorityMap = process.env
	.INDICATIVE_TO_MAKER_AUTHORITY_MAP
	? (JSON.parse(process.env.INDICATIVE_TO_MAKER_AUTHORITY_MAP) as Record<
			string,
			string
	  >)
	: {};
const subaccountToIndicative = new Map<string, string>();
const enableMockFillEndpoint =
	process.env.ENABLE_MOCK_FILL_ENDPOINT?.toLowerCase() === 'true';
const mockOnlyMode = process.env.MOCK_ONLY_MODE?.toLowerCase() === 'true';
const mockFillPort = process.env.MOCK_FILL_PORT
	? parseInt(process.env.MOCK_FILL_PORT)
	: 9470;
logger.info(`RPC endpoint: ${endpoint}`);
logger.info(`WS endpoint:  ${wsEndpoint}`);
logger.info(`DriftEnv:     ${driftEnv}`);
logger.info(`Commit:       ${commitHash}`);

const startMockFillEndpoint = (
	processFillEvent: (fillEvent: FillEvent) => Promise<void>
) => {
	if (!enableMockFillEndpoint) {
		return;
	}

	const app = express();
	app.use(express.json());
	app.post('/mockFill', async (req, res) => {
		try {
			const fillEvent = req.body as FillEvent;
			await processFillEvent({
				...fillEvent,
				makerIndicativeKey: fillEvent.maker
					? subaccountToIndicative.get(fillEvent.maker)
					: undefined,
			} as FillEvent);
			res.status(200).json({ ok: true });
		} catch (error) {
			logger.error('Failed to process mock fill:', error);
			res.status(500).json({ ok: false });
		}
	});
	app.listen(mockFillPort, () => {
		logger.info(
			`Mock fill endpoint listening on http://localhost:${mockFillPort}`
		);
	});
};

const preloadMakerAccountCache = async () => {
	for (const [indicativeMaker, authority] of Object.entries(
		indicativeToMakerAuthorityMap
	)) {
		try {
			const userAccounts =
				await driftClient.getUserAccountsAndAddressesForAuthority(
					new PublicKey(authority)
				);
			for (const userAccount of userAccounts) {
				subaccountToIndicative.set(
					userAccount.publicKey.toBase58(),
					indicativeMaker
				);
			}
			logger.info(
				`Preloaded ${userAccounts.length} subaccounts for indicative maker ${indicativeMaker}`
			);
		} catch (error) {
			logger.error(
				`Failed to preload subaccounts for indicative maker ${indicativeMaker}:`,
				error
			);
		}
	}
};

const main = async () => {
	const wallet = new Wallet(new Keypair());
	const clearingHousePublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const connection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
	});

	driftClient = new DriftClient({
		connection,
		wallet,
		programID: clearingHousePublicKey,
		accountSubscription: {
			type: 'websocket',
			commitment: stateCommitment,
			resubTimeoutMs: 30_000,
		},
		env: driftEnv,
	});

	const redisClient = new RedisClient({ prefix: redisClientPrefix });
	await redisClient.connect();
	const indicativeQuotesRedisClient = new RedisClient({});
	await indicativeQuotesRedisClient.connect();
	await driftClient.subscribe();
	await preloadMakerAccountCache();

	const { processFillEvent } = createTradeMetricsProcessor({
		redisClientPrefix,
		indicativeQuoteMaxAgeMs,
		indicativeQuotesCacheTtlMs,
		spotMarketPrecisionResolver: (marketIndex) =>
			sdkConfig.SPOT_MARKETS[marketIndex]?.precision,
		publisherRedisClient: redisClient,
		indicativeQuotesRedisClient,
		metrics: {
			marketFillCount,
			indicativePresenceCount,
			indicativeCompetitiveOpportunityCount,
			indicativeCompetitiveFillCount,
			indicativeCompetitiveOpportunityNotional,
			indicativeCompetitiveCapturedNotional,
			indicativeFillVsQuoteOutcomeCount,
			indicativeTotalSizeOnBookGauge,
			indicativeCompetitiveSizeOnBookGauge,
		},
		onError: (error) =>
			logger.error('Error evaluating competitive indicative quotes:', error),
	});

	startMockFillEndpoint(processFillEvent);

	if (mockOnlyMode) {
		logger.info('Running in MOCK_ONLY_MODE; skipping chain subscriptions');
		return;
	}

	const slotSubscriber = new SlotSubscriber(connection, {
		resubTimeoutMs: 10_000,
	});

	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	logger.info(
		`DriftClient ProgramId: ${driftClient.program.programId.toBase58()}`
	);
	logger.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	logger.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);
	driftClient.eventEmitter.on('error', (e) => {
		logger.error(e);
	});

	await slotSubscriber.subscribe();

	const eventSubscriber = new EventSubscriber(
		connection,
		driftClient.program as any,
		{
			maxTx: 8192,
			maxEventsPerType: 4096,
			orderBy: 'client',
			commitment: 'confirmed',
			logProviderConfig: {
				type: 'polling',
				frequency: 1000,
			},
		}
	);

	await eventSubscriber.subscribe();

	const eventObservable = fromEvent(eventSubscriber.eventEmitter, 'newEvent');
	eventObservable
		.pipe(
			filter(
				(event) =>
					event.eventType === 'OrderActionRecord' &&
					JSON.stringify(event.action) === JSON.stringify(OrderAction.FILL)
			),
			map((fill: Event<OrderActionRecord>) => {
				const basePrecision =
					getVariant(fill.marketType) === 'spot'
						? sdkConfig.SPOT_MARKETS[fill.marketIndex].precision
						: BASE_PRECISION;
				return {
					ts: fill.ts.toNumber(),
					marketIndex: fill.marketIndex,
					marketType: getVariant(fill.marketType),
					filler: fill.filler?.toBase58(),
					takerFee: convertToNumber(fill.takerFee, QUOTE_PRECISION),
					makerFee: convertToNumber(fill.makerFee, QUOTE_PRECISION),
					quoteAssetAmountSurplus: convertToNumber(
						fill.quoteAssetAmountSurplus,
						QUOTE_PRECISION
					),
					baseAssetAmountFilled: convertToNumber(
						fill.baseAssetAmountFilled,
						basePrecision
					),
					quoteAssetAmountFilled: convertToNumber(
						fill.quoteAssetAmountFilled,
						QUOTE_PRECISION
					),
					taker: fill.taker?.toBase58(),
					takerOrderId: fill.takerOrderId,
					takerOrderDirection: fill.takerOrderDirection
						? getVariant(fill.takerOrderDirection)
						: undefined,
					takerOrderBaseAssetAmount: convertToNumber(
						fill.takerOrderBaseAssetAmount,
						basePrecision
					),
					takerOrderCumulativeBaseAssetAmountFilled: convertToNumber(
						fill.takerOrderCumulativeBaseAssetAmountFilled,
						basePrecision
					),
					takerOrderCumulativeQuoteAssetAmountFilled: convertToNumber(
						fill.takerOrderCumulativeQuoteAssetAmountFilled,
						QUOTE_PRECISION
					),
					maker: fill.maker?.toBase58(),
					makerOrderId: fill.makerOrderId,
					makerOrderDirection: fill.makerOrderDirection
						? getVariant(fill.makerOrderDirection)
						: undefined,
					makerOrderBaseAssetAmount: convertToNumber(
						fill.makerOrderBaseAssetAmount,
						basePrecision
					),
					makerOrderCumulativeBaseAssetAmountFilled: convertToNumber(
						fill.makerOrderCumulativeBaseAssetAmountFilled,
						basePrecision
					),
					makerOrderCumulativeQuoteAssetAmountFilled: convertToNumber(
						fill.makerOrderCumulativeQuoteAssetAmountFilled,
						QUOTE_PRECISION
					),
					oraclePrice: convertToNumber(fill.oraclePrice, PRICE_PRECISION),
					txSig: fill.txSig,
					slot: fill.slot,
					fillRecordId: fill.fillRecordId?.toNumber(),
					action: 'fill',
					actionExplanation: getVariant(fill.actionExplanation),
					referrerReward: convertToNumber(
						new BN(fill.referrerReward ?? ZERO),
						QUOTE_PRECISION
					),
					bitFlags: fill.bitFlags,
				} as FillEvent;
			})
		)
		.subscribe(async (fillEvent: FillEvent) => {
			await processFillEvent({
				...fillEvent,
				makerIndicativeKey: fillEvent.maker
					? subaccountToIndicative.get(fillEvent.maker)
					: undefined,
			});
		});

	console.log('Publishing trades');
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
