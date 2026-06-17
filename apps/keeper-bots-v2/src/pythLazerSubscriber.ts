import { Channel, PythLazerClient } from '@pythnetwork/pyth-lazer-sdk';
import { DriftEnv, PerpMarkets } from '@drift-labs/sdk';
import { RedisClient } from '@drift-labs/common/clients';
import * as axios from 'axios';

export type PythLazerPriceFeedArray = {
	channel?: Channel;
	priceFeedIds: number[];
};
/**
 * @deprecated
 * Deprecated - use PythLazerSubscriber from @drift-labs/sdk instead
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

	constructor(
		private endpoints: string[],
		private token: string,
		private priceFeedArrays: PythLazerPriceFeedArray[],
		env: DriftEnv = 'devnet',
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
			logger: console,
		});
		let subscriptionId = 1;
		for (const priceFeedIds of this.priceFeedArrays) {
			const feedIdsHash = this.hash(priceFeedIds.priceFeedIds);
			this.feedIdHashToFeedIds.set(feedIdsHash, priceFeedIds.priceFeedIds);
			this.subscriptionIdsToFeedIdsHash.set(subscriptionId, feedIdsHash);
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
			this.pythLazerClient.send({
				type: 'subscribe',
				subscriptionId,
				priceFeedIds: priceFeedIds.priceFeedIds,
				properties: ['price', 'bestAskPrice', 'bestBidPrice', 'exponent'],
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
					properties: ['price', 'bestAskPrice', 'bestBidPrice', 'exponent'],
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
