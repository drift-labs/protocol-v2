import { LogProvider, logProviderCallback } from './types';
import {
	Commitment,
	Connection,
	Context,
	Logs,
	PublicKey,
} from '@solana/web3.js';
import { EventEmitter } from 'events';

/**
 * `LogProvider` backed by `connection.onLogs` — a raw Solana websocket log
 * subscription for `address`. Delivers only new logs from the point of
 * subscribe (no history) and does not attempt any batching; errored
 * transactions (`logs.err !== null`) are dropped. If `resubTimeoutMs` is set,
 * the provider watches for a gap with no log data and automatically
 * unsubscribes/resubscribes, emitting `'reconnect'` on `eventEmitter` with
 * the running attempt count each time — `EventSubscriber` uses that to fail
 * over to `PollingLogProvider` after enough attempts.
 */
export class WebSocketLogProvider implements LogProvider {
	private subscriptionId?: number;
	private isUnsubscribing = false;
	private externalUnsubscribe = false;
	private receivingData = false;
	private timeoutId?: ReturnType<typeof setTimeout>;
	private reconnectAttempts = 0;
	eventEmitter?: EventEmitter;
	private callback?: logProviderCallback;
	/**
	 * @param connection RPC connection to subscribe on.
	 * @param address Account/program address to receive logs for.
	 * @param commitment Commitment level for the log subscription.
	 * @param resubTimeoutMs If set, resubscribe when no log data arrives for this many ms; also enables `eventEmitter`/`'reconnect'`. Left unset, the provider never auto-resubscribes and `eventEmitter` stays `undefined`.
	 */
	public constructor(
		private connection: Connection,
		private address: PublicKey,
		private commitment: Commitment,
		private resubTimeoutMs?: number
	) {
		if (this.resubTimeoutMs) {
			this.eventEmitter = new EventEmitter();
		}
	}

	/** Establishes the `onLogs` subscription (retrying once after 2s if the websocket isn't ready yet). Always resolves `true`; `skipHistory` is accepted for `LogProvider` interface compatibility but has no effect here (this provider never delivers history). */
	public async subscribe(callback: logProviderCallback): Promise<boolean> {
		if (this.subscriptionId != null) {
			return true;
		}

		// reset teardown flags for a fresh subscription cycle — a caller-initiated
		// unsubscribe(true) leaves externalUnsubscribe set, which would otherwise
		// permanently suppress the heartbeat-driven resubscribe watchdog here
		this.isUnsubscribing = false;
		this.externalUnsubscribe = false;

		this.callback = callback;
		try {
			this.setSubscription(callback);
		} catch (error) {
			// Sometimes ws connection isn't ready, give it a few secs
			setTimeout(() => this.setSubscription(callback), 2000);
		}

		if (this.resubTimeoutMs) {
			this.setTimeout();
		}

		return true;
	}

	/** Raw `connection.onLogs` registration used internally by `subscribe` (and to reconnect). Filters out errored transactions before invoking `callback`. */
	public setSubscription(callback: logProviderCallback): void {
		this.subscriptionId = this.connection.onLogs(
			this.address,
			(logs: Logs, ctx: Context) => {
				if (this.resubTimeoutMs && !this.isUnsubscribing) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					this.setTimeout();
					if (this.reconnectAttempts > 0) {
						console.log('Resetting reconnect attempts to 0');
					}
					this.reconnectAttempts = 0;
				}
				if (logs.err !== null) {
					return;
				}
				callback(logs.signature, ctx.slot, logs.logs, undefined, undefined);
			},
			this.commitment
		);
	}

	public isSubscribed(): boolean {
		return this.subscriptionId != null;
	}

	/**
	 * Removes the websocket log listener and clears the resub timeout.
	 * @param external Whether this is a caller-initiated unsubscribe rather than an internal one during a reconnect cycle; controls whether the resub timeout is allowed to fire again afterward.
	 * @returns `true` on success (including when already unsubscribed), `false` if `removeOnLogsListener` threw (logged to console).
	 */
	public async unsubscribe(external = false): Promise<boolean> {
		this.isUnsubscribing = true;
		this.externalUnsubscribe = external;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.subscriptionId != null) {
			try {
				await this.connection.removeOnLogsListener(this.subscriptionId);
				this.subscriptionId = undefined;
				this.isUnsubscribing = false;
				return true;
			} catch (err) {
				console.log('Error unsubscribing from logs: ', err);
				this.isUnsubscribing = false;
				return false;
			}
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

			if (this.receivingData) {
				console.log(
					`webSocketLogProvider: No log data in ${
						this.resubTimeoutMs
					}ms, resubscribing on attempt ${this.reconnectAttempts + 1}`
				);
				await this.unsubscribe();
				this.receivingData = false;
				this.reconnectAttempts++;
				this.eventEmitter?.emit('reconnect', this.reconnectAttempts);
				if (this.callback) {
					this.subscribe(this.callback);
				}
			}
		}, this.resubTimeoutMs);
	}
}
