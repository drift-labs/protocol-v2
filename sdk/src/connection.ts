import { Connection } from '@solana/web3.js';
import { promiseTimeout } from './util/promiseTimeout';

/**
 * Wraps multiple Connections, rotating through them as they error out.
 */
export class MultiConnection {
	private connections: Array<Connection>;
	private activeIdx = 0;

	constructor(connections: Array<Connection>) {
		this.connections = connections;
	}

	private advanceActiveIdx() {
		this.activeIdx = (this.activeIdx + 1) % this.connections.length;
	}

	async _rpcRequest(method: string, params: any): Promise<any> {
		try {
			const result = await promiseTimeout(
				// @ts-ignore
				this.connections[this.activeIdx]._rpcRequest(method, params),
				1000
			);
			if (result === null) {
				// trigger RPC rotation
				this.advanceActiveIdx();
				console.error(
					`rotating RPCs due to timeout: ${
						this.connections[this.activeIdx].rpcEndpoint
					}`
				);
			}
			return Promise.resolve(result);
		} catch (e) {
			// trigger RPC rotation
			this.advanceActiveIdx();
			console.error(e);
			console.error(
				`rotating RPCs due to error, new RPC: ${
					this.connections[this.activeIdx].rpcEndpoint
				}`
			);
		}
	}
}
