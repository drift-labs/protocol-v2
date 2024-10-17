import { GrpcConfigs } from '../accounts/types';
import { DriftClient } from '../driftClient';
import { UserAccount } from '../types';
import { ConfirmOptions, PublicKey } from '@solana/web3.js';

export type AuctionSubscriberConfig = {
	driftClient: DriftClient;
	opts?: ConfirmOptions;
	resubTimeoutMs?: number;
	logResubMessages?: boolean;
	grpcConfigs?: GrpcConfigs;
};

export interface AuctionSubscriberEvents {
	onAccountUpdate: (
		account: UserAccount,
		pubkey: PublicKey,
		slot: number
	) => void;
}
