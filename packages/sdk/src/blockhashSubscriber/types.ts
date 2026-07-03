import { Commitment, Connection } from '@solana/web3.js';

/** Configuration for `BlockhashSubscriber`. */
export type BlockhashSubscriberConfig = {
	/** RPC URL to poll block hashes from; a `Connection` is constructed from it if `connection` is not provided. One of `rpcUrl`/`connection` must be supplied. */
	rpcUrl?: string;
	/** Existing `Connection` to poll block hashes on, taking precedence over `rpcUrl` if both are given. One of `rpcUrl`/`connection` must be supplied. */
	connection?: Connection;
	/** Commitment level for both the blockhash and block-height polls; defaults to `'confirmed'`. */
	commitment?: Commitment;
	/** Poll interval in milliseconds; defaults to `1000`. */
	updateIntervalMs?: number;
};
