import {
	Channel,
	PriceFeedProperty,
	PythLazerClient,
} from '@pythnetwork/pyth-lazer-sdk';
import { VelocityEnv, PerpMarkets } from '@velocity-exchange/sdk';
import { RedisClient } from '@velocity-exchange/common/clients';
import * as axios from 'axios';
import { logger } from './logger';

// ts-log compatible logger for the pyth-lazer client. debug/trace are dropped:
// the WebSocketPool logs "Dropping duplicate message" at debug for every message
// deduped across its redundant connections (~once per 200ms per extra
// connection), which floods stdout. info/warn/error still surface.
const lazerLogger = {
	trace: () => {},
	debug: () => {},
	info: (...args: unknown[]) => logger.info(args.map(String).join(' ')),
	warn: (...args: unknown[]) => logger.warn(args.map(String).join(' ')),
	error: (...args: unknown[]) => logger.error(args.map(String).join(' ')),
};

export type PythLazerPriceFeedArray = {
	channel?: Channel;
	priceFeedIds: number[];
};
/**
 * @deprecated
 * Deprecated - use PythLazerSubscriber from @velocity-exchange/sdk instead
 */
export class PythLazerSubscriber {
	private pythLazerClient?: PythLazerClient;
	feedIdChunkToPriceMessage: Map<string, string> = new Map();
	feedIdToPrice: Map<number, number> = new Map();
	feedIdHashToFeedIds: Map<string, number[]> = new Map();
	subscriptionIdsToFeedIdsHash: Map<number, string> = new Map();
	allSubscribedIds: number[] = [];

	timeoutId?: NodeJS.Timeout;
	receivingData = false;
	isUnsubscribing = false;

	marketIndextoPriceFeedIdChunk: Map<number, number[]> = new Map();
	marketIndextoPriceFeedId: Map<number, number> = new Map();
	useHttpRequests: boolean = false;
	// When a redisClient is supplied (and we're not in the http-fallback mode),
	// read price messages published by pyth-lazer-relayer from Redis instead of
	// opening our own Lazer WS connections. This collapses the per-bot connection
	// fan-out (N bots × M sockets on one token/IP) down to the single relayer.
	readFromRedis: boolean = false;

	constructor(
		private endpoints: string[],
		private token: string,
		private priceFeedArrays: PythLazerPriceFeedArray[],
		env: VelocityEnv = 'devnet',
		private redisClient?: RedisClient,
		private httpEndpoints: string[] = [],
		private resubTimeoutMs: number = 2000
	) {
		const markets = PerpMarkets[env].filter(
			(market) => market.pythLazerId !== undefined
		);

		this.allSubscribedIds = this.priceFeedArrays
			.map((array) => array.priceFeedIds)
			.flat();
		if (
			priceFeedArrays[0].priceFeedIds.length === 1 &&
			this.allSubscribedIds.length > 3 &&
			this.httpEndpoints.length > 0
		) {
			this.useHttpRequests = true;
		}

		// Pure-Redis mode: a redisClient with no http fallback configured. The
		// relayer publishes `pythLazerData:<feedId>` ({ data, ts }); we read those
		// and never dial Lazer ourselves.
		this.readFromRedis = redisClient !== undefined && !this.useHttpRequests;

		for (const priceFeedIds of priceFeedArrays) {
			const filteredMarkets = markets.filter((market) =>
				priceFeedIds.priceFeedIds.includes(market.pythLazerId!)
			);
			for (const market of filteredMarkets) {
				this.marketIndextoPriceFeedIdChunk.set(
					market.marketIndex,
					priceFeedIds.priceFeedIds
				);
				this.marketIndextoPriceFeedId.set(
					market.marketIndex,
					market.pythLazerId!
				);
			}
		}
	}

	async subscribe() {
		// Read from the relayer's Redis instead of opening our own Lazer sockets.
		if (this.readFromRedis) {
			if (this.redisClient && !this.redisClient.connected) {
				await this.redisClient.connect();
			}
			return;
		}

		// Will use http requests if chunk size is 1 and there are more than 3 ids
		if (this.useHttpRequests) {
			return;
		}

		this.pythLazerClient = await PythLazerClient.create({
			webSocketPoolConfig: {
				urls: this.endpoints,
				numConnections: 2,
				rwsConfig: {
					heartbeatTimeoutDurationMs: 5000,
					maxRetryDelayMs: 1000,
					logAfterRetryCount: 10,
				},
			},
			token: this.token,
			logger: lazerLogger,
		});
		// addMessageListener is global to the client (fires for every message,
		// not scoped to a subscription), and each message carries its own
		// subscriptionId — so one listener serves all subscriptions. Registering
		// it per chunk would run every message once per chunk.
		this.pythLazerClient.addMessageListener((message) => {
			this.receivingData = true;
			clearTimeout(this.timeoutId);
			switch (message.type) {
				case 'json': {
					if (message.value.type == 'streamUpdated') {
						if (message.value.solana?.data) {
							this.feedIdChunkToPriceMessage.set(
								this.subscriptionIdsToFeedIdsHash.get(
									message.value.subscriptionId
								)!,
								message.value.solana.data
							);
						}
						if (message.value.parsed?.priceFeeds) {
							for (const priceFeed of message.value.parsed.priceFeeds) {
								const price =
									Number(priceFeed.price!) *
									Math.pow(10, Number(priceFeed.exponent!));
								this.feedIdToPrice.set(priceFeed.priceFeedId, price);
							}
						}
					}
					break;
				}
				default: {
					break;
				}
			}
			this.setTimeout();
		});

		let subscriptionId = 1;
		for (const priceFeedIds of this.priceFeedArrays) {
			const feedIdsHash = this.hash(priceFeedIds.priceFeedIds);
			this.feedIdHashToFeedIds.set(feedIdsHash, priceFeedIds.priceFeedIds);
			this.subscriptionIdsToFeedIdsHash.set(subscriptionId, feedIdsHash);
			// Use subscribe() (not send()): subscribe() registers the request with
			// the pool so it is replayed on every socket (re)connect. send() fires
			// once and is never replayed, so after the first 5s heartbeat reconnect
			// the connection goes silent — no stream data, perpetual reconnect loop
			// ("Connection timed out. Reconnecting..."). It also covers the initial
			// race where a pool connection isn't open yet at subscribe time.
			this.pythLazerClient.subscribe({
				type: 'subscribe',
				subscriptionId,
				priceFeedIds: priceFeedIds.priceFeedIds,
				// `feedUpdateTimestamp` is REQUIRED: the velocity program's
				// PostPythLazerOracleUpdate handler skips the update with
				// "next_timestamp is None" unless the payload carries it.
				// (5.2.1's PriceFeedProperty type omits it, but the Lazer
				// server supports the wire string, so cast.)
				properties: [
					'price',
					'bestAskPrice',
					'bestBidPrice',
					'exponent',
					'feedUpdateTimestamp' as PriceFeedProperty,
				],
				formats: ['solana'],
				deliveryFormat: 'json',
				channel: priceFeedIds.channel ?? ('fixed_rate@200ms' as Channel),
				jsonBinaryEncoding: 'hex',
			});
			subscriptionId++;
		}

		this.receivingData = true;
		this.setTimeout();
	}

	protected setTimeout(): void {
		this.timeoutId = setTimeout(async () => {
			if (this.isUnsubscribing) {
				// If we are in the process of unsubscribing, do not attempt to resubscribe
				return;
			}

			if (this.receivingData) {
				console.log(`No ws data from pyth lazer client resubscribing`);
				await this.unsubscribe();
				this.receivingData = false;
				await this.subscribe();
			}
		}, this.resubTimeoutMs);
	}

	async unsubscribe() {
		this.isUnsubscribing = true;
		this.pythLazerClient?.shutdown();
		this.pythLazerClient = undefined;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;
		this.isUnsubscribing = false;
	}

	hash(arr: number[]): string {
		return 'h:' + arr.join('|');
	}

	async getLatestPriceMessage(feedIds: number[]): Promise<string | undefined> {
		if (this.readFromRedis && this.redisClient) {
			const priceMessage = (await this.redisClient.get(
				`pythLazerData:${feedIds[0]}`
			)) as { data: string; ts: number } | undefined;
			// Same 5s freshness guard the on-chain post relies on — a stale blob
			// carries a stale feedUpdateTimestamp and would be skipped by the program.
			if (priceMessage?.data && Date.now() - priceMessage.ts < 5000) {
				return priceMessage.data;
			}
			return undefined;
		}
		if (this.useHttpRequests) {
			if (feedIds.length === 1 && this.redisClient) {
				const priceMessage = (await this.redisClient.get(
					`pythLazerData:${feedIds[0]}`
				)) as { data: string; ts: number } | undefined;
				if (priceMessage?.data && Date.now() - priceMessage.ts < 5000) {
					return priceMessage.data;
				}
			}
			for (const url of this.httpEndpoints) {
				const priceMessage = await this.fetchLatestPriceMessage(url, feedIds);
				if (priceMessage) {
					return priceMessage;
				}
			}
			console.log(`pythLazer price undefined`);
			return undefined;
		}
		return this.feedIdChunkToPriceMessage.get(this.hash(feedIds));
	}

	async fetchLatestPriceMessage(
		url: string,
		feedIds: number[]
	): Promise<string | undefined> {
		try {
			const result = await axios.default.post(
				url,
				{
					priceFeedIds: feedIds,
					// `feedUpdateTimestamp` is REQUIRED — see note on the WS
					// subscribe path; without it the on-chain update is skipped.
					properties: [
						'price',
						'bestAskPrice',
						'bestBidPrice',
						'exponent',
						'feedUpdateTimestamp',
					],
					chains: ['solana'],
					channel: 'real_time',
					jsonBinaryEncoding: 'hex',
				},
				{
					headers: {
						Authorization: `Bearer ${this.token}`,
					},
				}
			);
			if (result.data && result.status == 200) {
				return result.data['solana']['data'];
			}
		} catch (e) {
			console.error(e);
			return undefined;
		}
	}

	async getLatestPriceMessageForMarketIndex(
		marketIndex: number
	): Promise<string | undefined> {
		const feedIds = this.marketIndextoPriceFeedIdChunk.get(marketIndex);
		if (!feedIds) {
			return undefined;
		}
		return await this.getLatestPriceMessage(feedIds);
	}

	getPriceFeedIdsFromMarketIndex(marketIndex: number): number[] {
		return this.marketIndextoPriceFeedIdChunk.get(marketIndex) || [];
	}

	getPriceFeedIdsFromHash(hash: string): number[] {
		return this.feedIdHashToFeedIds.get(hash) || [];
	}

	getPriceFromMarketIndex(marketIndex: number): number | undefined {
		const feedId = this.marketIndextoPriceFeedId.get(marketIndex);
		if (feedId === undefined) {
			return undefined;
		}
		return this.feedIdToPrice.get(feedId);
	}
}
