import {
	Commitment,
	GetMultipleAccountsConfig,
	PublicKey,
	RpcResponseAndContext,
	AccountInfo,
} from '@solana/web3.js';
import { promiseTimeout } from './util/promiseTimeout';

// interface for solana Connection
interface SolanaConnection {
	rpcEndpoint: string;

	getMultipleAccountsInfoAndContext(
		publicKeys: PublicKey[],
		commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
	): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>>;
}

/**
 * Wraps multiple Connections, rotating through them as they error out.
 */
export class MultiConnection implements SolanaConnection {
	private connections: Array<SolanaConnection>;
	private timeoutMs: number;
	private activeIdx = 0;

	// getter for rpcEndpoint
	get rpcEndpoint(): string {
		return this.connections[this.activeIdx].rpcEndpoint;
	}

	constructor(connections: Array<SolanaConnection>, timeoutMs?: number) {
		this.connections = connections;
		this.timeoutMs = timeoutMs || 1000;
	}

	private advanceActiveIdx() {
		this.activeIdx = (this.activeIdx + 1) % this.connections.length;
	}

	async getMultipleAccountsInfoAndContext(
		publicKeys: PublicKey[],
		commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
	): Promise<RpcResponseAndContext<(AccountInfo<Buffer> | null)[]>> {
		try {
			const result = await promiseTimeout(
				this.connections[this.activeIdx].getMultipleAccountsInfoAndContext(
					publicKeys,
					commitmentOrConfig
				),
				this.timeoutMs
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
