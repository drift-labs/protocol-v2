import { program } from 'commander';

import { Connection, Commitment, Keypair } from '@solana/web3.js';

import {
	DriftClient,
	initialize,
	DriftEnv,
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
const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const commitHash = process.env.COMMIT;
const redisClientPrefix = RedisClientPrefix.DLOB_HELIUS;
// Set up express for health checks
const app = express();

//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });
let driftClient: DriftClient;

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
logger.info(`DriftEnv:     ${driftEnv}`);
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
		const [resultPerp, resultSpot] = await Promise.all([
			fetch(this.endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(
					this.perpMarketPubkeys.map((xx) => {
						return {
							jsonrpc: '2.0',
							id: xx.marketIndex.toString(),
							method: 'getPriorityFeeEstimate',
							params: [
								{
									accountKeys: [xx.pubkey],
									options: {
										includeAllPriorityFeeLevels: true,
									},
								},
							],
						};
					})
				),
			}),
			fetch(this.endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(
					this.spotMarketPubkeys.map((xx) => {
						return {
							jsonrpc: '2.0',
							id: (100 + xx.marketIndex).toString(),
							method: 'getPriorityFeeEstimate',
							params: [
								{
									accountKeys: xx.pubkeys,
									options: {
										includeAllPriorityFeeLevels: true,
									},
								},
							],
						};
					})
				),
			}),
		]);

		const [dataPerp, dataSpot] = await Promise.all([
			resultPerp.json(),
			resultSpot.json(),
		]);

		dataPerp.forEach((result: any) => {
			const marketIndex = parseInt(result['id']);
			this.redisClient.publish(
				`${redisClientPrefix}priorityFees_perp_${marketIndex}`,
				result.result['priorityFeeLevels']
			);
			this.redisClient.set(
				`priorityFees_perp_${marketIndex}`,
				result.result['priorityFeeLevels']
			);
		});

		dataSpot.forEach((result: any) => {
			const marketIndex = parseInt(result['id']) - 100;
			this.redisClient.publish(
				`${redisClientPrefix}priorityFees_spot_${marketIndex}`,
				result.result['priorityFeeLevels']
			);
			this.redisClient.set(
				`priorityFees_spot_${marketIndex}`,
				result.result['priorityFeeLevels']
			);
		});
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

	const driftClient = new DriftClient({
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
	await driftClient.subscribe();

	const perpMarketPubkeys = driftClient.getPerpMarketAccounts().map((acct) => {
		return { marketIndex: acct.marketIndex, pubkey: acct.pubkey.toString() };
	});

	const usdcMarket = driftClient.getSpotMarketAccount(0).pubkey.toString();
	const spotMarketPubkeys: { marketIndex: number; pubkeys: string[] }[] = [];
	for (const market of sdkConfig.SPOT_MARKETS) {
		const pubkeysForMarket = [usdcMarket];

		const driftMarket = driftClient.getSpotMarketAccount(market.marketIndex);
		pubkeysForMarket.push(driftMarket.pubkey.toString());

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

export { sdkConfig, endpoint, wsEndpoint, driftEnv, commitHash, driftClient };
