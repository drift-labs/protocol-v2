import { GrpcConfigs } from '../accounts/types';
import { VelocityClient } from '../velocityClient';
import { UserAccount } from '../types';
import { ConfirmOptions, PublicKey } from '@solana/web3.js';

type AuctionSubscriberConfigBase = {
	/** Confirm options (notably `commitment`) for the underlying program-account subscription; defaults to `velocityClient.opts`. */
	opts?: ConfirmOptions;
	/** Max time with no update before the subscription resubscribes. */
	resubTimeoutMs?: number;
	/** Whether to log resubscribe attempts. */
	logResubMessages?: boolean;
	/** gRPC/Geyser endpoint config; only consumed by `AuctionSubscriberGrpc`, ignored by `AuctionSubscriber`. */
	grpcConfigs?: GrpcConfigs;
};

/** Configuration for `AuctionSubscriber`/`AuctionSubscriberGrpc`. */
export type AuctionSubscriberConfig = AuctionSubscriberConfigBase & {
	velocityClient: VelocityClient;
};

/** Events emitted on `AuctionSubscriber`/`AuctionSubscriberGrpc`'s `eventEmitter`. */
export interface AuctionSubscriberEvents {
	/** Fired whenever a `User` account with at least one order currently in its auction window is created or updated. */
	onAccountUpdate: (
		account: UserAccount,
		pubkey: PublicKey,
		slot: number
	) => void;
}
