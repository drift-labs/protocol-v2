// import WebSocket from 'ws';
import { logProviderCallback, EventType, LogProvider } from './types';
import { EventEmitter } from 'events';

// browser support
let WebSocketImpl: typeof WebSocket;
if (typeof window !== 'undefined' && window.WebSocket) {
	WebSocketImpl = window.WebSocket;
} else {
	WebSocketImpl = require('ws');
}

const EVENT_SERVER_HEARTBEAT_INTERVAL_MS = 5000;
const ALLOWED_MISSED_HEARTBEATS = 3;

export class EventsServerLogProvider implements LogProvider {
	private ws?: WebSocket;
	private callback?: logProviderCallback;
	private isUnsubscribing = false;
	private externalUnsubscribe = false;
	private lastHeartbeat = 0;
	private timeoutId?: NodeJS.Timeout;
	private reconnectAttempts = 0;
	eventEmitter?: EventEmitter;

	public constructor(
		private readonly url: string,
		private readonly eventTypes: EventType[],
		private readonly userAccount?: string
	) {
		this.eventEmitter = new EventEmitter();
	}

	public isSubscribed(): boolean {
		return this.ws !== undefined;
	}

	public async subscribe(callback: logProviderCallback): Promise<boolean> {
		if (this.ws !== undefined) {
			return true;
		}
		this.ws = new WebSocketImpl(this.url);

		this.callback = callback;
		this.ws.addEventListener('open', () => {
			for (const channel of this.eventTypes) {
				const subscribeMessage = {
					type: 'subscribe',
					channel: channel,
				};
				if (this.userAccount) {
					subscribeMessage['user'] = this.userAccount;
				}
				this.ws.send(JSON.stringify(subscribeMessage));
			}
			this.reconnectAttempts = 0;
		});

		this.ws.addEventListener('message', (data) => {
			try {
				if (!this.isUnsubscribing) {
					clearTimeout(this.timeoutId);
					this.setTimeout();
					if (this.reconnectAttempts > 0) {
						console.log(
							'eventsServerLogProvider: Resetting reconnect attempts to 0'
						);
					}
					this.reconnectAttempts = 0;
				}

				const parsedData = JSON.parse(data.data.toString());
				if (parsedData.channel === 'heartbeat') {
					this.lastHeartbeat = Date.now();
					return;
				}
				if (parsedData.message !== undefined) {
					return;
				}
				const event = JSON.parse(parsedData.data);
				this.callback(
					event.txSig,
					event.slot,
					[
						'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH invoke [1]',
						event.rawLog,
						'Program dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH success',
					],
					undefined,
					event.txSigIndex
				);
			} catch (error) {
				console.error('Error parsing message:', error);
			}
		});

		this.ws.addEventListener('close', () => {
			console.log('eventsServerLogProvider: WebSocket closed');
		});

		this.ws.addEventListener('error', (error) => {
			console.error('eventsServerLogProvider: WebSocket error:', error);
		});

		this.setTimeout();

		return true;
	}

	public async unsubscribe(external = false): Promise<boolean> {
		this.isUnsubscribing = true;
		this.externalUnsubscribe = external;
		if (this.timeoutId) {
			clearInterval(this.timeoutId);
			this.timeoutId = undefined;
		}

		if (this.ws !== undefined) {
			this.ws.close();
			this.ws = undefined;
			return true;
		} else {
			this.isUnsubscribing = false;
			return true;
		}
	}

	private setTimeout(): void {
		this.timeoutId = setTimeout(async () => {
			if (this.isUnsubscribing || this.externalUnsubscribe) {
				// If we are in the process of unsubscribing, do not attempt to resubscribe
				return;
			}

			const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
			if (
				timeSinceLastHeartbeat >
				EVENT_SERVER_HEARTBEAT_INTERVAL_MS * ALLOWED_MISSED_HEARTBEATS
			) {
				console.log(
					`eventServerLogProvider: No heartbeat in ${timeSinceLastHeartbeat}ms, resubscribing on attempt ${
						this.reconnectAttempts + 1
					}`
				);
				await this.unsubscribe();
				this.reconnectAttempts++;
				this.eventEmitter.emit('reconnect', this.reconnectAttempts);
				this.subscribe(this.callback);
			}
		}, EVENT_SERVER_HEARTBEAT_INTERVAL_MS * 2);
	}
}
