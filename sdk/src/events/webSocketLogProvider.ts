import { LogProvider, logProviderCallback } from './types';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';

export class WebSocketLogProvider implements LogProvider {
	private subscriptionId: number;
	public constructor(
		private connection: Connection,
		private address: PublicKey,
		private commitment: Commitment
	) {}

	public subscribe(callback: logProviderCallback): boolean {
		if (this.subscriptionId) {
			return true;
		}

		this.subscriptionId = this.connection.onLogs(
			this.address,
			(logs, ctx) => {
				callback(logs.signature, ctx.slot, logs.logs, undefined);
			},
			this.commitment
		);
		return true;
	}

	public isSubscribed(): boolean {
		return this.subscriptionId !== undefined;
	}

	public async unsubscribe(): Promise<boolean> {
		if (this.subscriptionId !== undefined) {
			await this.connection.removeOnLogsListener(this.subscriptionId);
			this.subscriptionId = undefined;
		}
		return true;
	}
}
