import {
	BlockhashWithExpiryBlockHeight,
	Commitment,
	Connection,
} from '@solana/web3.js';
import { BlockhashFetcher } from './types';

export class BaseBlockhashFetcher implements BlockhashFetcher {
	constructor(
		private connection: Connection,
		private blockhashCommitment: Commitment
	) {}

	public async getLatestBlockhash(): Promise<
		BlockhashWithExpiryBlockHeight | undefined
	> {
		return this.connection.getLatestBlockhash(this.blockhashCommitment);
	}
}
