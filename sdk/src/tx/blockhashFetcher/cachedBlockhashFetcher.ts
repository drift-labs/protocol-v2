import {
	BlockhashWithExpiryBlockHeight,
	Commitment,
	Connection,
} from '@solana/web3.js';
import { BlockhashFetcher } from './types';

/**
 * Fetches the latest blockhash and caches it for a configurable amount of time.
 *
 * - Prevents RPC spam by reusing cached values
 * - Retries on failure with exponential backoff
 * - Prevents concurrent requests for the same blockhash
 */
export class CachedBlockhashFetcher implements BlockhashFetcher {
	private recentBlockhashCache: {
		value: BlockhashWithExpiryBlockHeight | undefined;
		lastUpdated: number;
	} = { value: undefined, lastUpdated: 0 };

	private blockhashFetchingPromise: Promise<void> | null = null;

	constructor(
		private connection: Connection,
		private blockhashCommitment: Commitment,
		private retryCount: number,
		private retrySleepTimeMs: number,
		private staleCacheTimeMs: number
	) {}

	private async fetchBlockhashWithRetry(): Promise<BlockhashWithExpiryBlockHeight> {
		for (let i = 0; i < this.retryCount; i++) {
			try {
				return await this.connection.getLatestBlockhash(
					this.blockhashCommitment
				);
			} catch (err) {
				if (i === this.retryCount - 1) {
					throw new Error('Failed to fetch blockhash after maximum retries');
				}
				await this.sleep(this.retrySleepTimeMs * 2 ** i);
			}
		}
		throw new Error('Failed to fetch blockhash after maximum retries');
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async updateBlockhashCache(): Promise<void> {
		const result = await this.fetchBlockhashWithRetry();
		this.recentBlockhashCache = {
			value: result,
			lastUpdated: Date.now(),
		};
	}

	public async getLatestBlockhash(): Promise<
		BlockhashWithExpiryBlockHeight | undefined
	> {
		if (this.isCacheStale()) {
			await this.refreshBlockhash();
		}
		return this.recentBlockhashCache.value;
	}

	private isCacheStale(): boolean {
		const lastUpdateTime = this.recentBlockhashCache.lastUpdated;
		return (
			!lastUpdateTime || Date.now() > lastUpdateTime + this.staleCacheTimeMs
		);
	}

	/**
	 * Refresh the blockhash cache, await a pending refresh if it exists
	 */
	private async refreshBlockhash(): Promise<void> {
		if (!this.blockhashFetchingPromise) {
			this.blockhashFetchingPromise = this.updateBlockhashCache();
			try {
				await this.blockhashFetchingPromise;
			} finally {
				this.blockhashFetchingPromise = null;
			}
		} else {
			await this.blockhashFetchingPromise;
		}
	}
}
