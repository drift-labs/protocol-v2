import { Commitment, Connection } from '@solana/web3.js';

export type BlockhashSubscriberConfig = {
	/// rpcUrl to poll block hashes from, one of rpcUrl or Connection must provided
	rpcUrl?: string;
	/// connection to poll block hashes from, one of rpcUrl or Connection must provided
	connection?: Connection;
	/// commitment to poll block hashes with, default is 'confirmed'
	commitment?: Commitment;
	/// interval to poll block hashes, default is 1000 ms
	updateIntervalMs?: number;
};
