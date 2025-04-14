import { Keypair } from '@solana/web3.js';
import { BN, DriftClient } from '..';
import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';
import WebSocket from 'ws';

const SEND_INTERVAL = 500;

type Quote = {
	bidPrice: BN;
	askPrice: BN;
	bidBaseAssetAmount: BN;
	askBaseAssetAmount: BN;
	marketIndex: number;
};

export class IndicativeQuotesSender {
	private heartbeatTimeout: NodeJS.Timeout | null = null;
	private sendQuotesInterval: NodeJS.Timeout | null = null;

	private readonly heartbeatIntervalMs = 60000;
	private ws: WebSocket | null = null;
	private driftClient: DriftClient;
	private connected = false;

	private quotes: Map<number, Quote> = new Map();

	constructor(
		private endpoint: string,
		private keypair: Keypair
	) {}

	generateChallengeResponse(nonce: string): string {
		const messageBytes = decodeUTF8(nonce);
		const signature = nacl.sign.detached(messageBytes, this.keypair.secretKey);
		const signatureBase64 = Buffer.from(signature).toString('base64');
		return signatureBase64;
	}

	handleAuthMessage(message: any): void {
		if (message['channel'] === 'auth' && message['nonce'] != null) {
			const signatureBase64 = this.generateChallengeResponse(message['nonce']);
			this.ws?.send(
				JSON.stringify({
					stake_pubkey: this.keypair.publicKey.toBase58(),
					pubkey: this.keypair.publicKey.toBase58(),
					signature: signatureBase64,
				})
			);
		}

		if (
			message['channel'] === 'auth' &&
			message['message']?.toLowerCase() === 'authenticated'
		) {
			this.connected = true;
		}
	}

	async connect(): Promise<void> {
		const ws = new WebSocket(
			this.endpoint + '?pubkey=' + this.keypair.publicKey.toBase58()
		);
		this.ws = ws;
		ws.on('open', async () => {
			console.log('Connected to the server');

			ws.on('message', async (data: WebSocket.Data) => {
				let message: string;
				try {
					message = JSON.parse(data.toString());
				} catch (e) {
					console.warn('Failed to parse json message: ', data.toString());
					return;
				}
				this.startHeartbeatTimer();

				if (message['channel'] === 'auth') {
					this.handleAuthMessage(message);
				}

				if (
					message['channel'] === 'auth' &&
					message['message']?.toLowerCase() === 'authenticated'
				) {
					this.sendQuotesInterval = setInterval(() => {
						if (this.connected) {
							for (const [marketIndex, quote] of this.quotes.entries()) {
								const message = {
									market_type: 'perp',
									market_index: marketIndex,
									bid_price: quote.bidPrice.toString(),
									ask_price: quote.askPrice.toString(),
									bid_size: quote.bidBaseAssetAmount.toString(),
									ask_size: quote.askBaseAssetAmount.toString(),
								};
								ws.send(JSON.stringify(message));
							}
						}
					}, SEND_INTERVAL);
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

		ws.on('unexpected-response', async (request, response) => {
			console.error(
				'Unexpected response, reconnecting in 5s:',
				response.statusCode
			);
			setTimeout(() => {
				if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
				if (this.sendQuotesInterval) clearInterval(this.sendQuotesInterval);
				this.reconnect();
			}, 5000);
		});

		ws.on('error', async (request, response) => {
			console.error('WS closed from error, reconnecting in 1s:', response);
			setTimeout(() => {
				if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
				if (this.sendQuotesInterval) clearInterval(this.sendQuotesInterval);
				this.reconnect();
			}, 1000);
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

	setQuote(quote: Quote) {
		this.quotes.set(quote.marketIndex, quote);
	}

	private reconnect() {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.terminate();
		}

		console.log('Reconnecting to WebSocket...');
		setTimeout(() => {
			this.connect();
		}, 1000);
	}
}
