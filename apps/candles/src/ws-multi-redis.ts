import { CandleResolutions, getPerpMarkets, logger } from '@backend/common';
import {
	CandleCacheRepository,
	MarketCacheRepository,
	Redis,
	RiskRepository,
} from '@backend/redis';
import {
	BASE_PRECISION,
	BASE_PRECISION_EXP,
	PRICE_PRECISION,
	PRICE_PRECISION_EXP,
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
} from '@velocity-exchange/sdk';
import Decimal from 'decimal.js';
import express from 'express';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
	incrementWsErrors,
	incrementWsMessages,
	updateWsConnections,
	updateWsSubscriptions,
} from './services/metrics';
import { ClientMessage, ServerResponse } from './types';

interface CustomWebSocket extends WebSocket {
	isAlive: boolean;
	clientId: string;
	subscriptions: Map<string, string>;
}

interface CustomWebSocketServer extends WebSocketServer {
	clients: Set<CustomWebSocket>;
}

type RedisInstanceType = 'primary' | 'orderbook' | 'usermap';

interface ChannelConfig {
	redisInstance: RedisInstanceType;
	generateUserChannel: (...params: string[]) => string;
	generateRedisChannel: (...params: string[]) => string;
	getInitialData: (...params: string[]) => Promise<any>;
	validateParams: (message: ClientMessage) => boolean;
	extractParams: (message: ClientMessage) => string[];
	formatSubscriptionMessage: (message: ClientMessage) => string;
	formatData: (rawData: string, params: string[]) => any;
}

class RedisManager {
	private instances: Map<RedisInstanceType, any> = new Map();
	private subscriptions: Map<RedisInstanceType, Set<string>> = new Map();

	constructor() {
		this.subscriptions.set('primary', new Set());
		this.subscriptions.set('orderbook', new Set());
		this.subscriptions.set('usermap', new Set());
	}

	registerInstance(type: RedisInstanceType, instance: any) {
		this.instances.set(type, instance);
	}

	getInstance(type: RedisInstanceType): ReturnType<typeof Redis> {
		const instance = this.instances.get(type);
		if (!instance) {
			throw new Error(`Redis instance '${type}' not found`);
		}
		return instance;
	}

	getSubscriptions(type: RedisInstanceType): Set<string> {
		return this.subscriptions.get(type)!;
	}

	hasActiveSubscription(type: RedisInstanceType, channel: string): boolean {
		return this.subscriptions.get(type)!.has(channel);
	}

	addSubscription(type: RedisInstanceType, channel: string) {
		this.subscriptions.get(type)!.add(channel);
	}

	removeSubscription(type: RedisInstanceType, channel: string) {
		this.subscriptions.get(type)!.delete(channel);
	}

	async disconnectAll() {
		await Promise.all(
			Array.from(this.instances.values()).map((instance) => instance.disconnect())
		);
	}
}

export const main = async () => {
	let totalSubscriptions = 0;

	const app = express();
	const redisManager = new RedisManager();

	redisManager.registerInstance('primary', Redis());
	redisManager.registerInstance(
		'orderbook',
		Redis({
			overrideRedisUrl: process.env.ORDERBOOK_REDIS_URL,
		})
	);
	redisManager.registerInstance(
		'usermap',
		Redis({
			overrideRedisUrl: process.env.USERMAP_REDIS_URL,
		})
	);

	const { generateCandleChannel, getLatestCandle } = CandleCacheRepository();
	const { MARKET_SUMMARY_KEY, MARKET_PRICING_KEY, getMarketSummary, getMarketPricing } =
		MarketCacheRepository();
	const { generateAccountUpdateKey } = RiskRepository();

	app.get('/health', (_, res) => {
		return res.status(200).json({
			status: 'OK',
			timestamp: new Date().toISOString(),
		});
	});

	const port = parseInt(process.env.PORT || '3000');
	const server = app.listen(port, () => {
		logger.info(`HTTP Server running on port ${port}`);
	});

	const wss = new WebSocketServer({
		server,
		path: '/ws',
		clientTracking: true,
		perMessageDeflate: true,
	}) as CustomWebSocketServer;

	const channelConfigs: Record<string, ChannelConfig> = {
		candle: {
			redisInstance: 'primary',
			generateUserChannel: (symbol: string, resolution: string) =>
				`candle:${symbol}:${resolution}`,
			generateRedisChannel: (symbol: string, resolution: string) =>
				generateCandleChannel(symbol, resolution as CandleResolutions),
			getInitialData: async (symbol: string, resolution: string) =>
				await getLatestCandle(symbol, resolution as CandleResolutions),
			validateParams: (message: ClientMessage) =>
				Boolean(message.symbol && message.resolution),
			extractParams: (message: ClientMessage) => [message.symbol!, message.resolution!],
			formatSubscriptionMessage: (message: ClientMessage) =>
				`Subscribed to ${message.symbol} ${message.resolution}`,
			formatData: (rawData: string) => JSON.parse(rawData),
		},
		markets: {
			redisInstance: 'primary',
			generateUserChannel: () => 'markets:summary',
			generateRedisChannel: () => MARKET_SUMMARY_KEY,
			getInitialData: async () => getMarketSummary(),
			validateParams: () => true,
			extractParams: () => [],
			formatSubscriptionMessage: () => 'Subscribed to markets updates',
			formatData: (rawData: string) => JSON.parse(rawData),
		},
		pricing: {
			redisInstance: 'primary',
			generateUserChannel: () => 'pricing',
			generateRedisChannel: () => MARKET_PRICING_KEY,
			getInitialData: async () => getMarketPricing(),
			validateParams: () => true,
			extractParams: () => [],
			formatSubscriptionMessage: () => 'Subscribed to pricing updates',
			formatData: (rawData: string) => JSON.parse(rawData),
		},
		user: {
			redisInstance: 'usermap',
			generateUserChannel: (accountId: string) => `user:${accountId}`,
			generateRedisChannel: (accountId: string) => generateAccountUpdateKey(accountId),
			getInitialData: async () => {},
			validateParams: (message: ClientMessage) => Boolean(message.accountId),
			extractParams: (message: ClientMessage) => [message.accountId!],
			formatSubscriptionMessage: () => 'Subscribed to user updates',
			formatData: (rawData: string) => JSON.parse(rawData),
		},
		notifications: {
			redisInstance: 'usermap',
			generateUserChannel: (authorityId: string) => `notifications:${authorityId}`,
			generateRedisChannel: (authorityId: string) => `notifications:${authorityId}`,
			getInitialData: async () => {},
			validateParams: (message: ClientMessage) => Boolean(message.authorityId),
			extractParams: (message: ClientMessage) => [message.authorityId!],
			formatSubscriptionMessage: () => 'Subscribed to notifications',
			formatData: (rawData: string) => JSON.parse(rawData),
		},
		orderbook: {
			redisInstance: 'orderbook',
			generateUserChannel: (symbol: string) => `orderbook:${symbol}`,
			generateRedisChannel: (symbol: string) => {
				const { marketIndex } =
					getPerpMarkets()?.find((market) => symbol === market.symbol) ?? {};
				return `dlob:orderbook_perp_${marketIndex}_grouped_1_indicative`;
			},
			getInitialData: async () => {},
			validateParams: (message: ClientMessage) =>
				Boolean(
					message.symbol &&
						getPerpMarkets().find((market) => message.symbol === market.symbol)
				),
			extractParams: (message: ClientMessage) => [message.symbol!],
			formatSubscriptionMessage: (message: ClientMessage) =>
				`Subscribed to ${message.symbol} orderbook`,
			formatData: (rawData: string, [symbol]) => {
				const data = JSON.parse(rawData);
				return {
					symbol,
					levels: [
						data.bids.map((bid: any) => [
							new Decimal(bid.price)
								.div(PRICE_PRECISION.toNumber())
								.toFixed(PRICE_PRECISION_EXP.toNumber()),
							new Decimal(bid.size)
								.div(BASE_PRECISION.toNumber())
								.toFixed(BASE_PRECISION_EXP.toNumber()),
						]),
						data.asks.map((ask: any) => [
							new Decimal(ask.price)
								.div(PRICE_PRECISION.toNumber())
								.toFixed(PRICE_PRECISION_EXP.toNumber()),
							new Decimal(ask.size)
								.div(BASE_PRECISION.toNumber())
								.toFixed(BASE_PRECISION_EXP.toNumber()),
						]),
					],
					oraclePrice: new Decimal(data.oracle)
						.div(QUOTE_PRECISION.toNumber())
						.toFixed(QUOTE_PRECISION_EXP.toNumber()),
					markPrice: new Decimal(data.markPrice)
						.div(QUOTE_PRECISION.toNumber())
						.toFixed(QUOTE_PRECISION_EXP.toNumber()),
					spreadQuote: new Decimal(data.spreadQuote)
						.div(QUOTE_PRECISION.toNumber())
						.toFixed(QUOTE_PRECISION_EXP.toNumber()),
					spreadPercent: new Decimal(data.spreadPct)
						.div(QUOTE_PRECISION.toNumber())
						.toFixed(QUOTE_PRECISION_EXP.toNumber()),
				};
			},
		},
	};

	const parseSubscriptionMessage = (
		message: ClientMessage
	): {
		channelType: string;
		userChannel: string;
		redisChannel: string;
		params: string[];
	} => {
		// Backward compatibility: If no channelType specified but symbol+resolution exist, assume candle
		if (!message.channelType && message.symbol && message.resolution) {
			const config = channelConfigs.candle;
			const params = config.extractParams(message);
			return {
				channelType: 'candle',
				userChannel: config.generateUserChannel(...params),
				redisChannel: config.generateRedisChannel(...params),
				params,
			};
		}

		if (message.channelType) {
			const config = channelConfigs[message.channelType];
			if (!config) {
				throw new Error(`Unknown channel type: ${message.channelType}`);
			}

			if (!config.validateParams(message)) {
				throw new Error(`Invalid parameters for channel type: ${message.channelType}`);
			}

			const params = config.extractParams(message);
			return {
				channelType: message.channelType,
				userChannel: config.generateUserChannel(...params),
				redisChannel: config.generateRedisChannel(...params),
				params,
			};
		}

		throw new Error('Invalid subscription message: missing channelType or symbol+resolution');
	};

	const findChannelConfig = (userChannel: string): ChannelConfig | undefined => {
		for (const [type, config] of Object.entries(channelConfigs)) {
			if (
				userChannel.startsWith(type + ':') ||
				userChannel === config.generateUserChannel()
			) {
				return config;
			}
		}
		return undefined;
	};

	wss.on('connection', async (ws: CustomWebSocket, req: IncomingMessage) => {
		logger.info('New client connected');

		ws.isAlive = true;
		ws.clientId = req.headers['sec-websocket-key'] as string;
		ws.subscriptions = new Map();

		updateWsConnections(wss.clients.size);

		ws.on('message', async (data: Buffer) => {
			try {
				const message: ClientMessage = JSON.parse(data.toString());

				let subscriptionDetails: {
					channelType: string;
					userChannel: string;
					redisChannel: string;
					params: string[];
				};

				if (message.type === 'subscribe' || message.type === 'unsubscribe') {
					subscriptionDetails = parseSubscriptionMessage(message);
				}

				const { channelType, userChannel, redisChannel, params } = subscriptionDetails!;
				const config = channelConfigs[channelType];
				const redisInstance = config.redisInstance;

				switch (message.type) {
					case 'subscribe':
						if (!ws.subscriptions.has(userChannel)) {
							const redisClient = redisManager.getInstance(redisInstance);

							const initialData = await config.getInitialData(...params);

							if (initialData) {
								const initResponse: ServerResponse = {
									type: 'init',
									channelType,
									data: initialData,
									// Backward compatibility for candle data
									...(channelType === 'candle' && {
										symbol: message.symbol,
										resolution: message.resolution,
										candle: initialData,
									}),
								};
								ws.send(JSON.stringify(initResponse));
							}

							if (!redisManager.hasActiveSubscription(redisInstance, redisChannel)) {
								await redisClient.subscribe([redisChannel], (redisMessage) => {
									try {
										incrementWsMessages();

										const formattedMessage = config.formatData(
											redisMessage,
											params
										);

										wss.clients.forEach((client: CustomWebSocket) => {
											if (
												client.readyState === WebSocket.OPEN &&
												client.subscriptions.has(userChannel)
											) {
												let responseMessage;
												if (channelType === 'candle') {
													// Backward compatibility: send as CandleMessage
													responseMessage = formattedMessage;
												} else {
													responseMessage = {
														type: 'update',
														channelType,
														channel: userChannel,
														data: formattedMessage,
													};
												}
												client.send(JSON.stringify(responseMessage));
											}
										});
									} catch (err) {
										incrementWsErrors();
										logger.error(`Error processing Redis message: ${err}`);
									}
								});

								redisManager.addSubscription(redisInstance, redisChannel);
							}

							ws.subscriptions.set(userChannel, redisChannel);

							const subscriptionResponse: ServerResponse = {
								type: 'subscription',
								message: config.formatSubscriptionMessage(message),
								channelType,
								channel: userChannel,
								// Backward compatibility for candle data
								...(channelType === 'candle' && {
									symbol: message.symbol,
									resolution: message.resolution,
								}),
							};

							ws.send(JSON.stringify(subscriptionResponse));

							totalSubscriptions++;
							updateWsSubscriptions(totalSubscriptions);
							logger.info(`Client ${ws.clientId} subscribed to ${userChannel}`);
						}
						break;

					case 'unsubscribe':
						if (ws.subscriptions.has(userChannel)) {
							const redisClient = redisManager.getInstance(redisInstance);

							let hasOtherSubscribers = false;
							wss.clients.forEach((client: CustomWebSocket) => {
								if (client !== ws && client.subscriptions.has(userChannel)) {
									hasOtherSubscribers = true;
								}
							});

							// Only unsubscribe from Redis if no other clients need this channel
							if (!hasOtherSubscribers) {
								await redisClient.unsubscribe([redisChannel]);
								redisManager.removeSubscription(redisInstance, redisChannel);
							}

							ws.subscriptions.delete(userChannel);

							totalSubscriptions--;
							updateWsSubscriptions(totalSubscriptions);

							logger.info(`Client ${ws.clientId} unsubscribed from ${userChannel}`);
						}
						break;

					default:
						logger.warn(`Unknown message type: ${message.type}`);
				}
			} catch (err) {
				logger.warn(`Error processing message: ${err}`);

				const errorResponse = {
					type: 'error',
					message: err instanceof Error ? err.message : 'Failed to process message',
				};

				ws.send(JSON.stringify(errorResponse));
			}
		});

		ws.on('pong', () => {
			ws.isAlive = true;
		});

		ws.on('close', async () => {
			updateWsConnections(wss.clients.size - 1);
			logger.info(`Client ${ws.clientId} disconnected`);

			for (const [userChannel, redisChannel] of ws.subscriptions) {
				const channelConfig = findChannelConfig(userChannel);
				const redisInstance = channelConfig?.redisInstance || 'primary';
				const redisClient = redisManager.getInstance(redisInstance);

				let hasOtherSubscribers = false;
				wss.clients.forEach((client: CustomWebSocket) => {
					if (client !== ws && client.subscriptions.has(userChannel)) {
						hasOtherSubscribers = true;
					}
				});

				// Only unsubscribe from Redis if no other clients need this channel
				if (!hasOtherSubscribers) {
					await redisClient.unsubscribe([redisChannel]);
					redisManager.removeSubscription(redisInstance, redisChannel);
				}
			}

			totalSubscriptions -= ws.subscriptions.size;
			updateWsSubscriptions(totalSubscriptions);

			ws.subscriptions.clear();
		});

		ws.on('error', (error: Error) => {
			incrementWsErrors();
			logger.error(`WebSocket error: ${error}`);
		});
	});

	const heartbeat = setInterval(() => {
		wss.clients.forEach((ws: CustomWebSocket) => {
			if (!ws.isAlive) {
				logger.info(`Terminating stale connection: ${ws.clientId}`);
				return ws.close();
			}
			ws.isAlive = false;
			ws.ping();
		});
	}, 30000);

	return {
		close: async () => {
			clearInterval(heartbeat);
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await redisManager.disconnectAll();
		},
	};
};

main()
	.then((server) => {
		process.on('SIGTERM', async () => {
			logger.info('Shutting down...');
			await server.close();
			process.exit(0);
		});
	})
	.catch(async (error) => {
		const { message } = error as Error;
		await logger.error(`Failed to start server: ${message}`);
		process.exit(1);
	});
