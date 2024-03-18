import { Commitment, Connection } from '@solana/web3.js';

export type BlockhashSubscriberConfig = {
	rpcUrl?: string;
	connection?: Connection;
	commitment?: Commitment;
	updateIntervalMs?: number;
};
