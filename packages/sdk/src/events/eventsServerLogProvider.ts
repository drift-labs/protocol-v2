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

/**
 * `LogProvider` backed by the Velocity-hosted events server: a websocket
 * that pushes pre-parsed events per subscribed channel (event type),
 * optionally filtered to one user account, instead of raw RPC logs. Expects
 * a heartbeat message on channel `'heartbeat'` at least every
 * `EVENT_SERVER_HEARTBEAT_INTERVAL_MS` (5s); if none arrives within 3 missed
 * intervals it closes and resubscribes, emitting `'reconnect'` on
 * `eventEmitter` with the attempt count. Each received event is repackaged
 * as a synthetic 3-line log array (`invoke` / raw log / `success`) so it can
 * be run back through the same `parseLogs` pipeline as RPC-sourced logs.
 */
export class EventsServerLogProvider implements LogProvider {
	private ws?: WebSocket;
	private callback?: logProviderCallback;
	private isUnsubscribing = false;
	private externalUnsubscribe = false;
	private lastHeartbeat = 0;
	private timeoutId?: ReturnType<typeof setTimeout>;
	private reconnectAttempts = 0;
	eventEmitter: EventEmitter = new EventEmitter();

	/**
	 * @param url Websocket URL of the Velocity events server.
	 * @param eventTypes Event type channels to subscribe to (one `subscribe` message sent per type on connect).
	 * @param userAccount If provided, scopes the subscription server-side to events for this user account (base58 pubkey string).
	 */
	public constructor(
		private readonly url: string,
		private readonly eventTypes: EventType[],
		private readonly userAccount?: string
	) {}

	public isSubscribed(): boolean {
		return this.ws !== undefined;
	}

	/** Opens the websocket and sends a `subscribe` message per configured event type once connected. `skipHistory` is accepted for `LogProvider` interface compatibility but has no effect (the server only ever pushes new events). Always resolves `true`; malformed inbound messages are caught and logged, not thrown. */
	public async subscribe(callback: logProviderCallback): Promise<boolean> {
		if (this.ws !== undefined) {
			return true;
		}
		const ws = new WebSocketImpl(this.url);
		this.ws = ws;

		// reset teardown flags for a fresh subscription cycle — the `ws !== undefined`
		// unsubscribe path (e.g. a heartbeat-timeout resubscribe) leaves isUnsubscribing
		// set, which would otherwise disable the watchdog and reconnect on this new socket
		this.isUnsubscribing = false;
		this.externalUnsubscribe = false;

		this.callback = callback;
		ws.addEventListener('open', () => {
			for (const channel of this.eventTypes) {
				const subscribeMessage: {
					type: string;
					channel: EventType;
					user?: string;
				} = {
					type: 'subscribe',
					channel: channel,
				};
				if (this.userAccount) {
					subscribeMessage.user = this.userAccount;
				}
				ws.send(JSON.stringify(subscribeMessage));
			}
			this.reconnectAttempts = 0;
		});

		ws.addEventListener('message', (data) => {
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
				if (this.callback === undefined) {
					return;
				}
				this.callback(
					event.txSig,
					event.slot,
					[
						'Program vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P invoke [1]',
						event.rawLog,
						'Program vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P success',
					],
					undefined,
					event.txSigIndex
				);
			} catch (error) {
				console.error('Error parsing message:', error);
			}
		});

		ws.addEventListener('close', () => {
			console.log('eventsServerLogProvider: WebSocket closed');
		});

		ws.addEventListener('error', (error) => {
			console.error('eventsServerLogProvider: WebSocket error:', error);
		});

		this.setTimeout();

		return true;
	}

	/**
	 * Closes the websocket and clears the heartbeat timeout.
	 * @param external Whether this is a caller-initiated unsubscribe rather than an internal one during a reconnect cycle.
	 * @returns Always resolves `true`.
	 */
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
				const callback = this.callback;
				await this.unsubscribe();
				this.reconnectAttempts++;
				this.eventEmitter.emit('reconnect', this.reconnectAttempts);
				if (callback !== undefined) {
					this.subscribe(callback);
				}
			}
		}, EVENT_SERVER_HEARTBEAT_INTERVAL_MS * 2);
	}
}
