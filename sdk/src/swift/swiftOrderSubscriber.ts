import {
	DevnetPerpMarkets,
	DriftClient,
	DriftEnv,
	MainnetPerpMarkets,
	OptionalOrderParams,
	SwiftOrderParamsMessage,
} from '..';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';
import WebSocket from 'ws';

export type SwiftOrderSubscriberConfig = {
	driftClient: DriftClient;
	driftEnv: DriftEnv;
	endpoint?: string;
	marketIndexes: number[];
	keypair: Keypair;
};

export class SwiftOrderSubscriber {
	private heartbeatTimeout: NodeJS.Timeout | null = null;
	private readonly heartbeatIntervalMs = 60000;
	private ws: WebSocket | null = null;
	private driftClient: DriftClient;
	subscribed = false;

	constructor(
		private config: SwiftOrderSubscriberConfig,
		private onOrder: (
			swiftOrderParams: OptionalOrderParams,
			orderSlot: number
		) => void
	) {
		this.driftClient = config.driftClient;
	}

	getSymbolForMarketIndex(marketIndex: number) {
		const markets =
			this.config.driftEnv === 'devnet'
				? DevnetPerpMarkets
				: MainnetPerpMarkets;
		return markets[marketIndex].symbol;
	}

	generateChallengeResponse(nonce: string) {
		const messageBytes = decodeUTF8(nonce);
		const signature = nacl.sign.detached(
			messageBytes,
			this.config.keypair.secretKey
		);
		const signatureBase64 = Buffer.from(signature).toString('base64');
		return signatureBase64;
	}

	handleAuthMessage(message: any) {
		if (message['channel'] === 'auth' && message['nonce'] != null) {
			const signatureBase64 = this.generateChallengeResponse(message['nonce']);
			this.ws?.send(
				JSON.stringify({
					pubkey: this.config.keypair.publicKey.toBase58(),
					signature: signatureBase64,
				})
			);
		}

		if (
			message['channel'] === 'auth' &&
			message['message']?.toLowerCase() === 'authenticated'
		) {
			this.subscribed = true;
			this.config.marketIndexes.forEach(async (marketIndex) => {
				this.ws?.send(
					JSON.stringify({
						action: 'subscribe',
						market_type: 'perp',
						market_name: this.getSymbolForMarketIndex(marketIndex),
					})
				);
				await new Promise((resolve) => setTimeout(resolve, 100));
			});
		}
	}

	async subscribe() {
		const endpoint =
			this.config.endpoint || this.config.driftEnv === 'devnet'
				? 'wss://master.swift.drift.trade/ws'
				: 'wss://swift.drift.trade/ws';
		const ws = new WebSocket(
			endpoint + '?pubkey=' + this.config.keypair.publicKey.toBase58()
		);
		this.ws = ws;
		ws.on('open', async () => {
			console.log('Connected to the server');

			ws.on('message', async (data: WebSocket.Data) => {
				const message = JSON.parse(data.toString());
				this.startHeartbeatTimer();

				if (message['channel'] === 'auth') {
					this.handleAuthMessage(message);
				}

				if (message['order']) {
					const order = JSON.parse(message['order']);
					const swiftOrderParamsBuf = Buffer.from(
						order['order_message'],
						'base64'
					);
					const { swiftOrderParams, slot }: SwiftOrderParamsMessage =
						this.driftClient.program.coder.types.decode(
							'SwiftOrderParamsMessage',
							swiftOrderParamsBuf
						);

					if (!swiftOrderParams.price) {
						console.error(
							`order has no price: ${JSON.stringify(swiftOrderParams)}`
						);
						return;
					}

					this.onOrder(swiftOrderParams, slot.toNumber());
				}
			});

			ws.on('close', () => {
				console.log('Disconnected from the server');
				this.reconnect();
			});

			ws.on('error', (error: Error) => {
				console.error('WebSocket error:', error);
				this.reconnect();
			});
		});
	}

	private startHeartbeatTimer() {
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}
		this.heartbeatTimeout = setTimeout(() => {
			console.warn('No heartbeat received within 30 seconds, reconnecting...');
			this.reconnect();
		}, this.heartbeatIntervalMs);
	}

	private reconnect() {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.terminate();
		}

		console.log('Reconnecting to WebSocket...');
		setTimeout(() => {
			this.subscribe();
		}, 1000);
	}
}
