import { LogProvider, logProviderCallback } from './types';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';

export class WebSocketLogProvider implements LogProvider {
	private subscriptionId: number;
	private isUnsubscribing = false;
	private externalUnsubscribe = false;
	private receivingData = false;
	private timeoutId?: NodeJS.Timeout;
	private reconnectAttempts = 0;
	eventEmitter?: EventEmitter;
	private callback?: logProviderCallback;
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

	public async subscribe(callback: logProviderCallback): Promise<boolean> {
		if (this.subscriptionId) {
			return true;
		}

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

	public setSubscription(callback: logProviderCallback): void {
		this.subscriptionId = this.connection.onLogs(
			this.address,
			(logs, ctx) => {
				if (this.resubTimeoutMs && !this.isUnsubscribing) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					this.setTimeout();
				}
				callback(logs.signature, ctx.slot, logs.logs, undefined);
			},
			this.commitment
		);
	}

	public isSubscribed(): boolean {
		return this.subscriptionId !== undefined;
	}

	public async unsubscribe(external = false): Promise<boolean> {
		this.isUnsubscribing = true;
		this.externalUnsubscribe = external;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.subscriptionId !== undefined) {
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
					`No log data in ${this.resubTimeoutMs}ms, resubscribing on attempt ${
						this.reconnectAttempts + 1
					}`
				);
				await this.unsubscribe();
				this.receivingData = false;
				this.reconnectAttempts++;
				this.eventEmitter.emit('reconnect', this.reconnectAttempts);
				this.subscribe(this.callback);
			}
		}, this.resubTimeoutMs);
	}
}
