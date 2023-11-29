import { LogProvider, logProviderCallback } from './types';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';

export class WebSocketLogProvider implements LogProvider {
	private subscriptionId: number;
	private wsConnection?: Connection;

	public constructor(
		private connection: Connection,
		private address: PublicKey,
		private commitment: Commitment,
		private useWhirligig = false
	) {
		this.useWhirligig = useWhirligig;

		if (this.useWhirligig) {
			this.wsConnection = new Connection(
				this.connection.rpcEndpoint + '/whirligig',
				this.commitment
			);
		}
	}

	public subscribe(callback: logProviderCallback): boolean {
		if (this.subscriptionId) {
			return true;
		}
		const wsConnection = this.wsConnection || this.connection;
		this.subscriptionId = wsConnection.onLogs(
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
