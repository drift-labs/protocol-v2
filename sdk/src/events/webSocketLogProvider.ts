import { LogProvider, logProviderCallback } from './types';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';

export class WebSocketLogProvider implements LogProvider {
	private subscriptionId: number;
	private isUnsubscribing = false;
	private receivingData = false;
	private timeoutId?: NodeJS.Timeout;
	private callback?: logProviderCallback;
	public constructor(
		private connection: Connection,
		private address: PublicKey,
		private commitment: Commitment,
		private resubTimeoutMs?: number
	) {}

	public subscribe(callback: logProviderCallback): boolean {
		if (this.subscriptionId) {
			return true;
		}

		this.callback = callback;
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

		if (this.resubTimeoutMs) {
			this.setTimeout();
		}

		return true;
	}

	public isSubscribed(): boolean {
		return this.subscriptionId !== undefined;
	}

	public async unsubscribe(): Promise<boolean> {
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);

		if (this.subscriptionId !== undefined) {
			this.connection
				.removeOnLogsListener(this.subscriptionId)
				.then(() => {
					this.subscriptionId = undefined;
					this.isUnsubscribing = false;
					return true;
				})
				.catch((err) => {
					console.log('Error unsubscribing from logs: ', err);
					this.isUnsubscribing = false;
					return false;
				});
		} else {
			this.isUnsubscribing = false;
			return true;
		}
	}

	private setTimeout(): void {
		this.timeoutId = setTimeout(async () => {
			if (this.isUnsubscribing) {
				// If we are in the process of unsubscribing, do not attempt to resubscribe
				return;
			}

			if (this.receivingData) {
				console.log(`No log data in ${this.resubTimeoutMs}ms, resubscribing`);
				await this.unsubscribe();
				this.receivingData = false;
				this.subscribe(this.callback);
			}
		}, this.resubTimeoutMs);
	}
}
