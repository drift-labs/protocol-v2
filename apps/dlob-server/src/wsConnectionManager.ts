import cors from 'cors';
import express from 'express';
import * as http from 'http';
import compression from 'compression';
import { WebSocket, WebSocketServer } from 'ws';
import { sleep, selectMostRecentBySlot, GROUPING_OPTIONS } from './utils/utils';
import { DriftEnv, PerpMarkets, SpotMarkets } from '@velocity-exchange/sdk';
import {
	RedisClient,
	RedisClientPrefix,
} from '@velocity-exchange/common/clients';
import { Metrics, GaugeValue } from './core/metricsV2';

// Stream selector with hysteresis to prevent flip-flopping between sources
const STREAM_SWITCH_THRESHOLD_MS = 10_000; // 10 seconds
const STREAM_STALE_THRESHOLD_MS = 3_000; // Consider stream stale if no message for 3 seconds

class StreamSelector {
	private activeStream: string | null = null;
	private streamLastMessageTime: Map<string, number> = new Map();
	private streamLastSlot: Map<string, number> = new Map();
	private streamLeadingSince: Map<string, number> = new Map();
	private streamHealthyGauge: GaugeValue;
	private activeStreamGauge: GaugeValue;
	private streams: string[];

	constructor(
		streams: string[],
		streamHealthyGauge: GaugeValue,
		activeStreamGauge: GaugeValue
	) {
		this.streams = streams;
		this.streamHealthyGauge = streamHealthyGauge;
		this.activeStreamGauge = activeStreamGauge;

		// Initialize all streams as unhealthy
		for (const stream of streams) {
			this.streamHealthyGauge.setLatestValue(0, { source: stream });
			this.activeStreamGauge.setLatestValue(0, { source: stream });
		}
	}

	// Record a message from a stream and return whether it should be forwarded
	recordMessage(stream: string, slot: number): boolean {
		const now = Date.now();
		this.streamLastMessageTime.set(stream, now);
		this.streamLastSlot.set(stream, slot);

		this.streamHealthyGauge.setLatestValue(1, { source: stream });

		if (this.activeStream === null) {
			this.setActiveStream(stream);
			return true;
		}

		// If this is from the active stream, forward it
		if (stream === this.activeStream) {
			// Reset leading times for other streams since active stream is still producing
			for (const s of this.streams) {
				if (s !== stream) {
					this.streamLeadingSince.delete(s);
				}
			}
			return true;
		}

		// This message is from a non-active stream
		const activeSlot = this.streamLastSlot.get(this.activeStream) || 0;
		const activeLastMessage =
			this.streamLastMessageTime.get(this.activeStream) || 0;

		// Check if active stream is stale
		if (now - activeLastMessage > STREAM_STALE_THRESHOLD_MS) {
			console.log(
				`Active stream ${this.activeStream} is stale (no message for ${
					now - activeLastMessage
				}ms), switching to ${stream}`
			);
			this.setActiveStream(stream);
			return true;
		}

		// Check if this stream has a more recent slot
		if (slot > activeSlot) {
			// Track how long this stream has been leading
			if (!this.streamLeadingSince.has(stream)) {
				this.streamLeadingSince.set(stream, now);
			}

			const leadingDuration = now - this.streamLeadingSince.get(stream)!;
			if (leadingDuration >= STREAM_SWITCH_THRESHOLD_MS) {
				console.log(
					`Stream ${stream} has been leading for ${leadingDuration}ms, switching from ${this.activeStream}`
				);
				this.setActiveStream(stream);
				return true;
			}
		} else {
			// This stream is not leading, reset its leading time
			this.streamLeadingSince.delete(stream);
		}

		// Don't forward messages from non-active streams that haven't proven themselves
		return false;
	}

	private setActiveStream(stream: string) {
		if (this.activeStream) {
			this.activeStreamGauge.setLatestValue(0, { source: this.activeStream });
		}

		this.activeStream = stream;
		this.activeStreamGauge.setLatestValue(1, { source: stream });
		this.streamLeadingSince.clear();

		console.log(`Active stream set to: ${stream}`);
	}

	getActiveStream(): string | null {
		return this.activeStream;
	}

	checkHealth() {
		const now = Date.now();
		let anyHealthy = false;

		for (const stream of this.streams) {
			const lastMessage = this.streamLastMessageTime.get(stream);
			const isHealthy =
				lastMessage && now - lastMessage < STREAM_STALE_THRESHOLD_MS;

			this.streamHealthyGauge.setLatestValue(isHealthy ? 1 : 0, {
				source: stream,
			});

			if (isHealthy) {
				anyHealthy = true;
			}
		}

		// If active stream is no longer healthy, try to switch
		if (this.activeStream) {
			const activeLastMessage = this.streamLastMessageTime.get(
				this.activeStream
			);
			if (
				!activeLastMessage ||
				now - activeLastMessage > STREAM_STALE_THRESHOLD_MS
			) {
				// Find a healthy stream to switch to
				for (const stream of this.streams) {
					const lastMessage = this.streamLastMessageTime.get(stream);
					if (lastMessage && now - lastMessage < STREAM_STALE_THRESHOLD_MS) {
						console.log(
							`Active stream ${this.activeStream} is unhealthy, switching to ${stream}`
						);
						this.setActiveStream(stream);
						break;
					}
				}
			}
		}

		return anyHealthy;
	}
}

// Set up env constants
require('dotenv').config();
const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const metricsPort = process.env.METRICS_PORT
	? parseInt(process.env.METRICS_PORT)
	: 9464;

const app = express();
app.use(cors({ origin: '*' }));
app.use(compression());
app.set('trust proxy', 1);

// init metrics
const metricsV2 = new Metrics('ws-connection-manager', undefined, metricsPort);
const wsConnectionsCounter = metricsV2.addCounter(
	'websocket_connections',
	'Number of active WebSocket connections'
);
const wsOrderbookSourceCounter = metricsV2.addCounter(
	'websocket_orderbook_source',
	'Number of orderbook messages sent from source'
);
const wsOrderbookSourceLastSlotGauge = metricsV2.addGauge(
	'websocket_orderbook_source_last_slot',
	'Last slot of orderbook messages from a source'
);
const wsStreamHealthyGauge = metricsV2.addGauge(
	'websocket_stream_healthy',
	'Whether a Redis stream source is healthy (1) or not (0). Alert if all sources are 0.'
);
const wsActiveStreamGauge = metricsV2.addGauge(
	'websocket_active_stream',
	'Whether a Redis stream source is currently active (1) or not (0). Only one source should be active at a time.'
);
metricsV2.finalizeObservables();

const server = http.createServer(app);
const wss = new WebSocketServer({
	server,
	path: '/ws',
	perMessageDeflate: true,
});

const WS_PORT = process.env.WS_PORT || '3000';

console.log(`WS LISTENER PORT : ${WS_PORT}`);

const MAX_BUFFERED_AMOUNT = 300000;

const envClients = [];
const clients = process.env.REDIS_CLIENT?.trim()
	.replace(/^\[|\]$/g, '')
	.split(/\s*,\s*/);

clients?.forEach((client) => envClients.push(RedisClientPrefix[client]));

const REDIS_CLIENTS = envClients.length
	? envClients
	: [RedisClientPrefix.DLOB, RedisClientPrefix.DLOB_HELIUS];
console.log('Redis Clients:', REDIS_CLIENTS);

const regexp = new RegExp(REDIS_CLIENTS.join('|'), 'g');
const sanitiseChannelForClient = (channel: string | undefined): string => {
	return channel?.replace(regexp, '');
};
const getChannelPrefix = (channel: string | undefined): string | undefined => {
	if (!channel) return undefined;
	const match = channel.match(regexp);
	return match?.[0];
};

const getRedisChannelFromMessage = (message: any): string => {
	const channel = message.channel;
	const marketName = message.market?.toUpperCase();
	const marketType = message.marketType?.toLowerCase();
	if (!['spot', 'perp'].includes(marketType)) {
		throw new Error('Bad market type specified');
	}

	let marketIndex: number;
	if (marketType === 'spot') {
		marketIndex = SpotMarkets[driftEnv].find(
			(market) => market.symbol.toUpperCase() === marketName
		).marketIndex;
	} else if (marketType === 'perp') {
		marketIndex = PerpMarkets[driftEnv].find(
			(market) => market.symbol.toUpperCase() === marketName
		).marketIndex;
	}

	if (marketIndex === undefined || marketIndex === null) {
		throw new Error('Bad market specified');
	}

	switch (channel.toLowerCase()) {
		case 'trades':
			return `trades_${marketType}_${marketIndex}`;
		case 'orderbook':
			if (
				message.grouping &&
				GROUPING_OPTIONS.includes(parseInt(message.grouping))
			) {
				return `orderbook_${marketType}_${marketIndex}_grouped_${message.grouping}`;
			}
			return `orderbook_${marketType}_${marketIndex}_grouped_1`;
		case 'orderbook_indicative': {
			if (
				message.grouping &&
				GROUPING_OPTIONS.includes(parseInt(message.grouping))
			) {
				return `orderbook_${marketType}_${marketIndex}_grouped_${message.grouping}_indicative`;
			}
			return `orderbook_${marketType}_${marketIndex}_grouped_1_indicative`;
		}
		case 'priorityfees':
			return `priorityFees_${marketType}_${marketIndex}`;
		case undefined:
		default:
			throw new Error('Bad channel specified');
	}
};

async function main() {
	const subscribedChannelToSlot: Map<string, number> = new Map();

	// Create stream selector for managing failover between Redis sources
	const streamSelector =
		REDIS_CLIENTS.length > 1
			? new StreamSelector(
					REDIS_CLIENTS,
					wsStreamHealthyGauge,
					wsActiveStreamGauge
			  )
			: null;

	// If only one client, mark it as healthy and active
	if (!streamSelector && REDIS_CLIENTS.length === 1) {
		wsStreamHealthyGauge.setLatestValue(1, { source: REDIS_CLIENTS[0] });
		wsActiveStreamGauge.setLatestValue(1, { source: REDIS_CLIENTS[0] });
	}

	// Periodic health check for stream selector
	if (streamSelector) {
		setInterval(() => {
			const anyHealthy = streamSelector.checkHealth();
			if (!anyHealthy) {
				console.error('WARNING: No healthy Redis streams available!');
			}
		}, 1000);
	}

	const redisClients: Array<RedisClient> = [];
	const lastMessageClients: Array<RedisClient> = [];
	for (let i = 0; i < REDIS_CLIENTS.length; i++) {
		const redisClient = new RedisClient({ prefix: REDIS_CLIENTS[i] });
		const lastMessageClient = new RedisClient({ prefix: REDIS_CLIENTS[i] });
		await redisClient.connect();
		await lastMessageClient.connect();

		lastMessageClients.push(lastMessageClient);
		redisClients.push(redisClient);

		redisClient.forceGetClient().on('connect', () => {
			subscribedChannels.forEach(async (channel) => {
				try {
					await redisClient.subscribe(channel);
				} catch (error) {
					console.error(`Error subscribing to ${channel}:`, error);
				}
			});
		});

		redisClient.forceGetClient().on('message', (subscribedChannel, message) => {
			const sanitizedChannel = sanitiseChannelForClient(subscribedChannel);
			const channelPrefix = getChannelPrefix(sanitizedChannel);
			const subscribers = channelSubscribers.get(sanitizedChannel);
			if (subscribers) {
				if (sanitizedChannel.includes('orderbook')) {
					const messageSlot = JSON.parse(message)['slot'];
					wsOrderbookSourceLastSlotGauge.setLatestValue(messageSlot, {
						source: channelPrefix,
					});

					if (streamSelector) {
						const shouldForward = streamSelector.recordMessage(
							channelPrefix,
							messageSlot
						);
						if (!shouldForward) {
							return;
						}
					} else {
						const lastMessageSlot =
							subscribedChannelToSlot.get(sanitizedChannel);
						if (!lastMessageSlot || lastMessageSlot <= messageSlot) {
							subscribedChannelToSlot.set(sanitizedChannel, messageSlot);
						} else if (lastMessageSlot > messageSlot) {
							return;
						}
					}

					// Update slot tracking for the forwarded message
					subscribedChannelToSlot.set(sanitizedChannel, messageSlot);
				}
				subscribers.forEach((ws) => {
					if (
						ws.readyState === WebSocket.OPEN &&
						ws.bufferedAmount < MAX_BUFFERED_AMOUNT
					) {
						wsOrderbookSourceCounter.add(1, {
							source: channelPrefix,
						});
						ws.send(
							JSON.stringify({
								channel: sanitizedChannel,
								data: message,
							})
						);
					}
				});
			}
		});

		redisClient.forceGetClient().on('error', (error) => {
			console.error('Redis client error:', error);
		});
	}

	const channelSubscribers = new Map<string, Set<WebSocket>>();
	const subscribedChannels = new Set<string>();

	wss.on('connection', (ws: WebSocket) => {
		wsConnectionsCounter.add(1, {});

		ws.on('message', async (msg) => {
			let parsedMessage: any;
			let messageType: string;
			try {
				parsedMessage = JSON.parse(msg.toString());
				messageType = parsedMessage.type.toLowerCase();
			} catch (e) {
				return;
			}

			switch (messageType) {
				case 'subscribe': {
					let redisChannel: string;
					try {
						redisChannel = getRedisChannelFromMessage(parsedMessage);
					} catch (error) {
						const requestChannel = sanitiseChannelForClient(
							parsedMessage?.channel
						);
						if (requestChannel) {
							ws.send(
								JSON.stringify({
									channel: requestChannel,
									error: 'Error subscribing to channel',
								})
							);
						} else {
							ws.close(
								1003,
								JSON.stringify({
									error: 'Error subscribing to channel',
								})
							);
						}
						return;
					}

					if (!subscribedChannels.has(redisChannel)) {
						console.log('Trying to subscribe to channel', redisChannel);
						redisClients[0]
							.subscribe(
								redisChannel.includes('priorityFees')
									? `dlob-helius:${redisChannel}`
									: `${redisClients[0].getPrefix()}${redisChannel}`
							)
							.then(() => {
								subscribedChannels.add(redisChannel);
							})
							.catch(() => {
								ws.send(
									JSON.stringify({
										error: `Error subscribing to channel: ${parsedMessage}`,
									})
								);
								return;
							});

						if (redisChannel.includes('orderbook') && redisClients.length > 1) {
							redisClients.slice(1).map((redisClient) => {
								redisClient
									.subscribe(`${redisClient.getPrefix()}${redisChannel}`)
									.catch(() => {
										ws.send(
											JSON.stringify({
												error: `Error subscribing to channel: ${parsedMessage}`,
											})
										);
										return;
									});
							});
						}
					}

					if (!channelSubscribers.get(redisChannel)) {
						const subscribers = new Set<WebSocket>();
						channelSubscribers.set(redisChannel, subscribers);
					}
					channelSubscribers.get(redisChannel).add(ws);

					ws.send(
						JSON.stringify({
							message: `Subscribe received for channel: ${parsedMessage.channel}, market: ${parsedMessage.market}, marketType: ${parsedMessage.marketType}`,
						})
					);
					// Fetch and send last message
					if (redisChannel.includes('orderbook')) {
						const lastMessages = await Promise.all(
							lastMessageClients.map((redisClient) =>
								redisClient.getRaw(
									`last_update_${redisChannel}`.replace(
										redisClient.getPrefix(),
										''
									)
								)
							)
						);
						const lastMessage = selectMostRecentBySlot(lastMessages);
						if (lastMessage) {
							ws.send(
								JSON.stringify({
									channel: redisChannel,
									data: JSON.stringify(lastMessage),
								})
							);
						}
					}

					break;
				}
				case 'unsubscribe': {
					let redisChannel: string;
					try {
						redisChannel = getRedisChannelFromMessage(parsedMessage);
					} catch (error) {
						const requestChannel = sanitiseChannelForClient(
							parsedMessage?.channel
						);
						if (requestChannel) {
							console.log('Error unsubscribing from channel:', error.message);
							ws.send(
								JSON.stringify({
									channel: requestChannel,
									error: 'Error unsubscribing from channel',
								})
							);
						} else {
							ws.close(
								1003,
								JSON.stringify({
									error: 'Error unsubscribing from channel',
								})
							);
						}
						return;
					}
					const subscribers = channelSubscribers.get(redisChannel);
					if (subscribers) {
						channelSubscribers.get(redisChannel).delete(ws);
					}
					break;
				}
				case undefined:
				default:
					break;
			}
		});

		// Set interval to send heartbeat every 5 seconds
		const heartbeatInterval = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ channel: 'heartbeat' }));
			} else {
				clearInterval(heartbeatInterval);
			}
		}, 5000);

		// Buffer overflow check interval
		const bufferInterval = setInterval(() => {
			if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
				if (ws.readyState === WebSocket.OPEN) {
					ws.close(1008, 'Buffer overflow');
				}
				clearInterval(bufferInterval);
			}
		}, 10000);

		// Handle disconnection
		ws.on('close', () => {
			// Clear any existing intervals
			clearInterval(heartbeatInterval);
			clearInterval(bufferInterval);
			channelSubscribers.forEach((subscribers, channel) => {
				if (subscribers.delete(ws) && subscribers.size === 0) {
					redisClients.map((redisClient) => redisClient.unsubscribe(channel));
					channelSubscribers.delete(channel);
					subscribedChannels.delete(channel);
				}
			});
			wsConnectionsCounter.add(-1, {});
		});

		ws.on('error', (error) => {
			console.error('Socket error:', error);
		});
	});

	server.listen(WS_PORT, () => {
		console.log(`connection manager running on ${WS_PORT}`);
	});

	server.on('error', (error) => {
		console.error('Server error:', error);
	});
}

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
