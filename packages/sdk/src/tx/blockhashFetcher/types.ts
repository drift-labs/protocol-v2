import { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';

export interface BlockhashFetcher {
	getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight | undefined>;
}
