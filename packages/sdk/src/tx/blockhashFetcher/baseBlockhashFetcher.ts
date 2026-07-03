import {
	BlockhashWithExpiryBlockHeight,
	Commitment,
	Connection,
} from '@solana/web3.js';
import { BlockhashFetcher } from './types';

/**
 * Simplest `BlockhashFetcher`: makes a fresh `getLatestBlockhash` RPC call on every request, no
 * caching or retry. Prefer `CachedBlockhashFetcher` for senders issuing many transactions in quick
 * succession to avoid RPC rate limits.
 */
export class BaseBlockhashFetcher implements BlockhashFetcher {
	/**
	 * @param connection - RPC connection to fetch the blockhash from.
	 * @param blockhashCommitment - Commitment level to request the blockhash at.
	 */
	constructor(
		private connection: Connection,
		private blockhashCommitment: Commitment
	) {}

	/**
	 * @returns The latest blockhash and its expiry block height, fetched fresh from `connection`.
	 */
	public async getLatestBlockhash(): Promise<
		BlockhashWithExpiryBlockHeight | undefined
	> {
		return this.connection.getLatestBlockhash(this.blockhashCommitment);
	}
}
