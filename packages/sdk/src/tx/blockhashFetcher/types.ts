import { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';

/** Strategy interface for obtaining a recent blockhash, abstracting whether it's fetched fresh every call or cached (see `BaseBlockhashFetcher`/`CachedBlockhashFetcher`). */
export interface BlockhashFetcher {
	/**
	 * @returns The latest blockhash and its expiry block height, or `undefined` if unavailable.
	 */
	getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight | undefined>;
}
