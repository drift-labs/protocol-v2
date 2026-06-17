import { CandleResolutions, logger, VolumeInterval } from '@backend/common';
import { CandleCacheRepository, MarketCacheRepository, Redis } from '@backend/redis';
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
	subscriptions: Set<string>;
}

interface CustomWebSocketServer extends WebSocketServer {
	clients: Set<CustomWebSocket>;
}

interface ChannelConfig {
	generateChannel: (...params: string[]) => string;
	getInitialData: (...params: string[]) => Promise<any>;
	validateParams: (message: ClientMessage) => boolean;
	extractParams: (message: ClientMessage) => string[];
	formatSubscriptionMessage: (message: ClientMessage) => string;
}

export const main = async () => {
	let totalSubscriptions = 0;
	// Track active Redis subscriptions to prevent duplicates
	const activeRedisSubscriptions = new Set<string>();

	const app = express();
	const redis = Redis();
	const { generateCandleChannel, getLatestCandle } = CandleCacheRepository();
	const {
		MARKET_SUMMARY_KEY,
		MARKET_PRICING_KEY,
		MARKET_VOLUME_PUBLISH_KEY,
		getMarketSummary,
		getMarketPricing,
		getMarketsVolume,
	} = MarketCacheRepository();

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
			generateChannel: (symbol: string, resolution: string) =>
				generateCandleChannel(symbol, resolution as CandleResolutions),
			getInitialData: async (symbol: string, resolution: string) =>
				await getLatestCandle(symbol, resolution as CandleResolutions),
			validateParams: (message: ClientMessage) =>
				Boolean(message.symbol && message.resolution),
			extractParams: (message: ClientMessage) => [message.symbol!, message.resolution!],
			formatSubscriptionMessage: (message: ClientMessage) =>
				`Subscribed to ${message.symbol} ${message.resolution}`,
		},
		volume: {
			generateChannel: () => MARKET_VOLUME_PUBLISH_KEY,
			getInitialData: async () =>
				getMarketsVolume({ interval: VolumeInterval.TWENTY_FOUR_HOUR }),
			validateParams: () => true,
			extractParams: () => [],
			formatSubscriptionMessage: () => 'Subscribed to 24h volume updates',
		},
		markets: {
			generateChannel: () => MARKET_SUMMARY_KEY,
			getInitialData: async () => getMarketSummary(),
			validateParams: () => true,
			extractParams: () => [],
			formatSubscriptionMessage: () => 'Subscribed to markets updates',
		},
		pricing: {
			generateChannel: () => MARKET_PRICING_KEY,
			getInitialData: async () => getMarketPricing(),
			validateParams: () => true,
			extractParams: () => [],
			formatSubscriptionMessage: () => 'Subscribed to pricing updates',
		},
	};

	const parseSubscriptionMessage = (
		message: ClientMessage
	): {
		channelType: string;
		channel: string;
		params: string[];
	} => {
		// Backward compatibility: If no channelType specified but symbol+resolution exist, assume candle
		if (!message.channelType && message.symbol && message.resolution) {
			const config = channelConfigs.candle;
			return {
				channelType: 'candle',
				channel: config.generateChannel(message.symbol, message.resolution),
				params: config.extractParams(message),
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
				channel: config.generateChannel(...params),
				params,
			};
		}

		throw new Error('Invalid subscription message: missing channelType or symbol+resolution');
	};

	wss.on('connection', async (ws: CustomWebSocket, req: IncomingMessage) => {
		logger.info('New client connected');

		ws.isAlive = true;
		ws.clientId = req.headers['sec-websocket-key'] as string;
		ws.subscriptions = new Set();

		updateWsConnections(wss.clients.size);

		ws.on('message', async (data: Buffer) => {
			try {
				const message: ClientMessage = JSON.parse(data.toString());

				let subscriptionDetails: {
					channelType: string;
					channel: string;
					params: string[];
				};

				if (message.type === 'subscribe' || message.type === 'unsubscribe') {
					subscriptionDetails = parseSubscriptionMessage(message);
				}

				const { channelType, channel, params } = subscriptionDetails!;

				switch (message.type) {
					case 'subscribe':
						if (!ws.subscriptions.has(channel)) {
							const config = channelConfigs[channelType];

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

							if (!activeRedisSubscriptions.has(channel)) {
								await redis.subscribe([channel], (redisMessage) => {
									try {
										incrementWsMessages();
										const parsedMessage = JSON.parse(redisMessage);

										wss.clients.forEach((client: CustomWebSocket) => {
											if (
												client.readyState === WebSocket.OPEN &&
												client.subscriptions.has(channel)
											) {
												let responseMessage;
												if (channelType === 'candle') {
													// Backward compatibility: send as CandleMessage
													responseMessage = parsedMessage;
												} else {
													responseMessage = {
														type: 'update',
														channelType,
														channel,
														data: parsedMessage,
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

								activeRedisSubscriptions.add(channel);
							}

							ws.subscriptions.add(channel);

							const subscriptionResponse: ServerResponse = {
								type: 'subscription',
								message: config.formatSubscriptionMessage(message),
								channelType,
								// Backward compatibility for candle data
								...(channelType === 'candle' && {
									symbol: message.symbol,
									resolution: message.resolution,
								}),
							};

							ws.send(JSON.stringify(subscriptionResponse));

							totalSubscriptions++;
							updateWsSubscriptions(totalSubscriptions);
							logger.info(`Client ${ws.clientId} subscribed to ${channel}`);
						}
						break;

					case 'unsubscribe':
						if (ws.subscriptions.has(channel)) {
							let hasOtherSubscribers = false;

							wss.clients.forEach((client: CustomWebSocket) => {
								if (client !== ws && client.subscriptions.has(channel)) {
									hasOtherSubscribers = true;
								}
							});

							// Only unsubscribe from Redis if no other clients need this channel
							if (!hasOtherSubscribers) {
								await redis.unsubscribe([channel]);
								activeRedisSubscriptions.delete(channel);
							}

							ws.subscriptions.delete(channel);

							totalSubscriptions--;
							updateWsSubscriptions(totalSubscriptions);

							logger.info(`Client ${ws.clientId} unsubscribed from ${channel}`);
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

			for (const channel of ws.subscriptions) {
				let hasOtherSubscribers = false;
				wss.clients.forEach((client: CustomWebSocket) => {
					if (client !== ws && client.subscriptions.has(channel)) {
						hasOtherSubscribers = true;
					}
				});

				// Only unsubscribe from Redis if no other clients need this channel
				if (!hasOtherSubscribers) {
					await redis.unsubscribe([channel]);
					activeRedisSubscriptions.delete(channel);
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
			await redis.disconnect();
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
