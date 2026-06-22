import { program } from 'commander';

import { Connection, Commitment, Keypair } from '@solana/web3.js';

import {
	VelocityClient,
	initialize,
	VelocityEnv,
	Wallet,
	BulkAccountLoader,
	getMarketsAndOraclesForSubscription,
} from '@velocity-exchange/sdk';
import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';

import { logger, setLogLevel } from '../utils/logger';
import { sleep } from '../utils/utils';
import express from 'express';
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(
	new Agent({
		connections: 200,
	})
);

require('dotenv').config();
const stateCommitment: Commitment = 'confirmed';
const velocityEnv = (process.env.ENV || 'devnet') as VelocityEnv;
const commitHash = process.env.COMMIT;
const redisClientPrefix = RedisClientPrefix.DLOB_HELIUS;
// Set up express for health checks
const app = express();

//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });
let velocityClient: VelocityClient;

const opts = program.opts();
setLogLevel(opts.debug ? 'debug' : 'info');

const token = process.env.TOKEN;
const endpoint = token
	? process.env.ENDPOINT + `/${token}`
	: process.env.ENDPOINT;
const wsEndpoint = process.env.WS_ENDPOINT;
const FEE_POLLING_FREQUENCY =
	parseInt(process.env.FEE_POLLING_FREQUENCY) || 5000;

if (!endpoint.includes('helius')) {
	throw new Error('We use helius for fee publisher fellas');
}

logger.info(`RPC endpoint: ${endpoint}`);
logger.info(`WS endpoint:  ${wsEndpoint}`);
logger.info(`VelocityEnv:     ${velocityEnv}`);
logger.info(`Commit:       ${commitHash}`);

class PriorityFeeSubscriber {
	endpoint: string;
	perpMarketPubkeys: { marketIndex: number; pubkey: string }[];
	spotMarketPubkeys: { marketIndex: number; pubkeys: string[] }[];
	redisClient: RedisClient;
	frequencyMs: number;

	constructor(config: {
		endpoint: string;
		redisClient: RedisClient;
		perpMarketPubkeys: { marketIndex: number; pubkey: string }[];
		spotMarketPubkeys: { marketIndex: number; pubkeys: string[] }[];
		frequencyMs?: number;
	}) {
		this.endpoint = config.endpoint;
		this.perpMarketPubkeys = config.perpMarketPubkeys;
		this.spotMarketPubkeys = config.spotMarketPubkeys;
		this.redisClient = config.redisClient;
		this.frequencyMs = config.frequencyMs ?? FEE_POLLING_FREQUENCY;
	}

	async subscribe() {
		await this.fetchAndPushPriorityFees();
		setInterval(async () => {
			await this.fetchAndPushPriorityFees();
		}, this.frequencyMs);
	}

	async fetchAndPushPriorityFees() {
		// Helius `getPriorityFeeEstimate` is a custom (Atlas) method that does NOT
		// support JSON-RPC batch (array) requests — sending an array body gets back
		// a single error object, which is why the old `.forEach` on the response
		// crashed every cycle. Send one request per market instead and read the
		// single result object. Run them concurrently; allSettled so one market's
		// failure doesn't drop the rest.
		const post = async (accountKeys: string[]): Promise<any> => {
			const res = await fetch(this.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: '1',
					method: 'getPriorityFeeEstimate',
					params: [
						{ accountKeys, options: { includeAllPriorityFeeLevels: true } },
					],
				}),
			});
			return res.json();
		};

		const publish = (
			kind: 'perp' | 'spot',
			marketIndex: number,
			data: any
		): void => {
			const levels = data?.result?.priorityFeeLevels;
			if (data?.error || !levels) {
				logger.warn(
					`getPriorityFeeEstimate ${kind} ${marketIndex} returned no levels: ` +
						`${JSON.stringify(data)?.slice(0, 300)}`
				);
				return;
			}
			this.redisClient.publish(
				`${redisClientPrefix}priorityFees_${kind}_${marketIndex}`,
				levels
			);
			this.redisClient.set(`priorityFees_${kind}_${marketIndex}`, levels);
		};

		await Promise.allSettled([
			...this.perpMarketPubkeys.map(async (xx) =>
				publish('perp', xx.marketIndex, await post([xx.pubkey]))
			),
			...this.spotMarketPubkeys.map(async (xx) =>
				publish('spot', xx.marketIndex, await post(xx.pubkeys))
			),
		]);
	}
}

const main = async () => {
	const connection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
	});

	const redisClient = new RedisClient({
		prefix: redisClientPrefix,
	});
	await redisClient.connect();

	const { perpMarketIndexes, spotMarketIndexes, oracleInfos } =
		getMarketsAndOraclesForSubscription(sdkConfig.ENV);

	const velocityClient = new VelocityClient({
		connection,
		wallet: new Wallet(new Keypair()),
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
		accountSubscription: {
			type: 'polling',
			accountLoader: new BulkAccountLoader(connection, stateCommitment, 0),
		},
	});
	await velocityClient.subscribe();

	const perpMarketPubkeys = velocityClient
		.getPerpMarketAccounts()
		.map((acct) => {
			return { marketIndex: acct.marketIndex, pubkey: acct.pubkey.toString() };
		});

	const usdcMarket = velocityClient.getSpotMarketAccount(0).pubkey.toString();
	const spotMarketPubkeys: { marketIndex: number; pubkeys: string[] }[] = [];
	for (const market of sdkConfig.SPOT_MARKETS) {
		const pubkeysForMarket = [usdcMarket];

		const velocityMarket = velocityClient.getSpotMarketAccount(
			market.marketIndex
		);
		pubkeysForMarket.push(velocityMarket.pubkey.toString());

		spotMarketPubkeys.push({
			marketIndex: market.marketIndex,
			pubkeys: pubkeysForMarket,
		});
	}

	const priorityFeeSubscriber = new PriorityFeeSubscriber({
		endpoint,
		perpMarketPubkeys,
		spotMarketPubkeys,
		redisClient,
	});

	await priorityFeeSubscriber.subscribe();
	const server = app.listen(8080);

	// Default keepalive is 5s, since the AWS ALB timeout is 60 seconds, clients
	// sometimes get 502s.
	// https://shuheikagawa.com/blog/2019/04/25/keep-alive-timeout/
	// https://stackoverflow.com/a/68922692
	server.keepAliveTimeout = 61 * 1000;
	server.headersTimeout = 65 * 1000;

	console.log('Priority fee publisher Publishing Messages');
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

export {
	sdkConfig,
	endpoint,
	wsEndpoint,
	velocityEnv,
	commitHash,
	velocityClient,
};
