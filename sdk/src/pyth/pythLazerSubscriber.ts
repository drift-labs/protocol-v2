import { Channel, PythLazerClient } from '@pythnetwork/pyth-lazer-sdk';
import { DriftEnv } from '../config';
import { PerpMarkets } from '../constants/perpMarkets';

/**
 * Configuration for a group of Pyth Lazer price feeds.
 */
export type PythLazerPriceFeedArray = {
	/** Optional channel for update frequency (e.g., 'fixed_rate@200ms') */
	channel?: Channel;
	/** Array of Pyth Lazer price feed IDs to subscribe to */
	priceFeedIds: number[];
};

type FeedSymbolInfo = {
	name: string;
	state: string;
};

/**
 * Manages subscriptions to Pyth Lazer price feeds and provides access to real-time price data.
 * Automatically filters out non-stable feeds and handles reconnection logic.
 */
export class PythLazerSubscriber {
	private static readonly SYMBOLS_API_URL =
		'https://history.pyth-lazer.dourolabs.app/history/v1/symbols';
	private symbolsCache: Map<number, FeedSymbolInfo> | null = null;
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

	/**
	 * Creates a new PythLazerSubscriber instance.
	 * @param endpoints - Array of WebSocket endpoint URLs for Pyth Lazer
	 * @param token - Authentication token for Pyth Lazer API
	 * @param priceFeedArrays - Array of price feed configurations to subscribe to
	 * @param env - Drift environment (mainnet-beta, devnet, etc.)
	 * @param resubTimeoutMs - Milliseconds to wait before resubscribing on data timeout
	 * @param sdkLogging - Whether to log Pyth SDK logs to the console. This is very noisy but could be useful for debugging.
	 */
	constructor(
		private endpoints: string[],
		private token: string,
		private priceFeedArrays: PythLazerPriceFeedArray[],
		env: DriftEnv = 'devnet',
		private resubTimeoutMs: number = 2000,
		private sdkLogging: boolean = false
	) {
		const markets = PerpMarkets[env].filter(
			(market) => market.pythLazerId !== undefined
		);

		this.allSubscribedIds = this.priceFeedArrays
			.map((array) => array.priceFeedIds)
			.flat();

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

	private async fetchSymbolsIfNeeded(): Promise<void> {
		if (this.symbolsCache !== null) return;

		try {
			const response = await fetch(PythLazerSubscriber.SYMBOLS_API_URL);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const symbols = await response.json();

			this.symbolsCache = new Map();
			for (const symbol of symbols) {
				this.symbolsCache.set(symbol.pyth_lazer_id, {
					name: symbol.name,
					state: symbol.state,
				});
			}
		} catch (error) {
			console.warn(
				`Failed to fetch Pyth Lazer symbols, proceeding with all feeds: ${error}`
			);
			this.symbolsCache = new Map(); // Empty map = no filtering
		}
	}

	private filterStableFeeds(feedIds: number[]): number[] {
		if (this.symbolsCache === null || this.symbolsCache.size === 0) {
			return feedIds; // No filtering if cache unavailable
		}

		return feedIds.filter((feedId) => {
			const info = this.symbolsCache!.get(feedId);
			if (!info) {
				console.warn(
					`Feed ID ${feedId} not found in symbols API, including anyway`
				);
				return true;
			}
			if (info.state !== 'stable') {
				console.warn(
					`Removing feed ID ${feedId} (${info.name}) - state is "${info.state}", not "stable"`
				);
				return false;
			}
			return true;
		});
	}

	/**
	 * Subscribes to Pyth Lazer price feeds. Automatically filters out non-stable feeds
	 * and establishes WebSocket connections for real-time price updates.
	 */
	async subscribe() {
		await this.fetchSymbolsIfNeeded();

		this.pythLazerClient = await PythLazerClient.create({
			token: this.token,
			logger: this.sdkLogging ? console : undefined,
			webSocketPoolConfig: {
				urls: this.endpoints,
				numConnections: 4, // Optionally specify number of parallel redundant connections to reduce the chance of dropped messages. The connections will round-robin across the provided URLs. Default is 4.
				onError: (error) => {
					console.error('⛔️ PythLazerClient error:', error.message);
				},
				onWebSocketError: (error) => {
					console.error('⛔️ WebSocket error:', error.message);
				},
				onWebSocketPoolError: (error) => {
					console.error('⛔️ WebSocket pool error:', error.message);
				},
				// Optional configuration for resilient WebSocket connections
				rwsConfig: {
					heartbeatTimeoutDurationMs: 5000, // Optional heartbeat timeout duration in milliseconds
					maxRetryDelayMs: 1000, // Optional maximum retry delay in milliseconds
					logAfterRetryCount: 10, // Optional log after how many retries
				},
			},
		});
		// Reset allSubscribedIds to rebuild with only stable feeds
		this.allSubscribedIds = [];

		let subscriptionId = 1;
		for (const priceFeedArray of this.priceFeedArrays) {
			const filteredFeedIds = this.filterStableFeeds(
				priceFeedArray.priceFeedIds
			);

			if (filteredFeedIds.length === 0) {
				console.warn(
					`All feeds filtered out for subscription ${subscriptionId}, skipping`
				);
				continue;
			}

			// Update allSubscribedIds with only stable feeds
			this.allSubscribedIds.push(...filteredFeedIds);

			const feedIdsHash = this.hash(filteredFeedIds);
			this.feedIdHashToFeedIds.set(feedIdsHash, filteredFeedIds);
			this.subscriptionIdsToFeedIdsHash.set(subscriptionId, feedIdsHash);

			// Update marketIndextoPriceFeedIdChunk to use filtered feeds
			for (const [
				marketIndex,
				chunk,
			] of this.marketIndextoPriceFeedIdChunk.entries()) {
				if (this.hash(chunk) === this.hash(priceFeedArray.priceFeedIds)) {
					this.marketIndextoPriceFeedIdChunk.set(marketIndex, filteredFeedIds);
				}
			}

			// Remove entries from marketIndextoPriceFeedId for filtered-out feeds
			for (const [
				marketIndex,
				feedId,
			] of this.marketIndextoPriceFeedId.entries()) {
				if (
					!filteredFeedIds.includes(feedId) &&
					priceFeedArray.priceFeedIds.includes(feedId)
				) {
					this.marketIndextoPriceFeedId.delete(marketIndex);
					this.marketIndextoPriceFeedIdChunk.delete(marketIndex);
				}
			}

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
				priceFeedIds: filteredFeedIds,
				properties: ['price', 'bestAskPrice', 'bestBidPrice', 'exponent'],
				formats: ['solana'],
				deliveryFormat: 'json',
				channel: priceFeedArray.channel ?? ('fixed_rate@200ms' as Channel),
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

	/**
	 * Unsubscribes from all Pyth Lazer price feeds and shuts down WebSocket connections.
	 */
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

	/**
	 * Retrieves the latest Solana-format price message for a group of feed IDs.
	 * @param feedIds - Array of price feed IDs
	 * @returns Hex-encoded price message data, or undefined if not available
	 */
	async getLatestPriceMessage(feedIds: number[]): Promise<string | undefined> {
		return this.feedIdChunkToPriceMessage.get(this.hash(feedIds));
	}

	/**
	 * Retrieves the latest Solana-format price message for a specific market.
	 * @param marketIndex - The market index to get price data for
	 * @returns Hex-encoded price message data, or undefined if not available
	 */
	async getLatestPriceMessageForMarketIndex(
		marketIndex: number
	): Promise<string | undefined> {
		const feedIds = this.marketIndextoPriceFeedIdChunk.get(marketIndex);
		if (!feedIds) {
			return undefined;
		}
		return await this.getLatestPriceMessage(feedIds);
	}

	/**
	 * Gets the array of price feed IDs associated with a market index.
	 * @param marketIndex - The market index to look up
	 * @returns Array of price feed IDs, or empty array if not found
	 */
	getPriceFeedIdsFromMarketIndex(marketIndex: number): number[] {
		return this.marketIndextoPriceFeedIdChunk.get(marketIndex) || [];
	}

	/**
	 * Gets the array of price feed IDs from a subscription hash.
	 * @param hash - The subscription hash
	 * @returns Array of price feed IDs, or empty array if not found
	 */
	getPriceFeedIdsFromHash(hash: string): number[] {
		return this.feedIdHashToFeedIds.get(hash) || [];
	}

	/**
	 * Gets the current parsed price for a specific market index.
	 * @param marketIndex - The market index to get the price for
	 * @returns The price as a number, or undefined if not available
	 */
	getPriceFromMarketIndex(marketIndex: number): number | undefined {
		const feedId = this.marketIndextoPriceFeedId.get(marketIndex);
		if (feedId === undefined) {
			return undefined;
		}
		return this.feedIdToPrice.get(feedId);
	}
}
