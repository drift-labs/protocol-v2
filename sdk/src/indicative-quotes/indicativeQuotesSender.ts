import { Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';
import WebSocket from 'ws';

const SEND_INTERVAL = 500;
const MAX_BUFFERED_AMOUNT = 20 * 1024; // 20 KB as worst case scenario

type Quote = {
	bidPrice: BN;
	askPrice: BN;
	bidBaseAssetAmount: BN;
	askBaseAssetAmount: BN;
	marketIndex: number;
	isOracleOffset?: boolean;
};

export class IndicativeQuotesSender {
	private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
	private sendQuotesInterval: ReturnType<typeof setTimeout> | null = null;

	private readonly heartbeatIntervalMs = 60000;
	private reconnectDelay = 1000;
	private ws: WebSocket | null = null;
	private connected = false;

	private quotes: Map<number, Quote[]> = new Map();

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
			this.reconnectDelay = 1000;

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
							for (const [marketIndex, quotes] of this.quotes.entries()) {
								const message = {
									market_index: marketIndex,
									market_type: 'perp',
									quotes: quotes.map((quote) => {
										return {
											bid_price: quote.bidPrice.toString(),
											ask_price: quote.askPrice.toString(),
											bid_size: quote.bidBaseAssetAmount.toString(),
											ask_size: quote.askBaseAssetAmount.toString(),
											is_oracle_offset: quote.isOracleOffset,
										};
									}),
								};
								try {
									if (
										this.ws?.readyState === WebSocket.OPEN &&
										this.ws?.bufferedAmount < MAX_BUFFERED_AMOUNT
									) {
										this.ws.send(JSON.stringify(message));
									}
								} catch (err) {
									console.error('Error sending quote:', err);
								}
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
				response?.statusCode
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

	setQuote(newQuotes: Quote | Quote[]): void {
		if (!this.connected) {
			console.warn('Setting quote before connected to the server, ignoring');
		}
		const quotes = Array.isArray(newQuotes) ? newQuotes : [newQuotes];
		const newQuoteMap = new Map<number, Quote[]>();
		for (const quote of quotes) {
			if (
				quote.marketIndex == null ||
				quote.bidPrice == null ||
				quote.askPrice == null ||
				quote.bidBaseAssetAmount == null ||
				quote.askBaseAssetAmount == null
			) {
				console.warn(
					'Received incomplete quote, ignoring and deleting old quote',
					quote
				);
				if (quote.marketIndex != null) {
					this.quotes.delete(quote.marketIndex);
				}
				return;
			}
			if (!newQuoteMap.has(quote.marketIndex)) {
				newQuoteMap.set(quote.marketIndex, []);
			}
			newQuoteMap.get(quote.marketIndex)?.push(quote);
		}
		for (const marketIndex of newQuoteMap.keys()) {
			this.quotes.set(marketIndex, newQuoteMap.get(marketIndex));
		}
	}

	private reconnect() {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.terminate();
		}

		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = null;
		}
		if (this.sendQuotesInterval) {
			clearInterval(this.sendQuotesInterval);
			this.sendQuotesInterval = null;
		}

		console.log(
			`Reconnecting to WebSocket in ${this.reconnectDelay / 1000} seconds...`
		);
		setTimeout(() => {
			this.connect();
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
		}, this.reconnectDelay);
	}
}
