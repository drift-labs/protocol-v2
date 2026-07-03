import { Commitment, PublicKey } from '@solana/web3.js';
import { Order, UserAccount } from '../types';
import { VelocityClient } from '../velocityClient';
import { GrpcConfigs } from '../accounts/types';

/** Configuration for `OrderSubscriber`. */
export type OrderSubscriberConfig = {
	velocityClient?: VelocityClient;
	/** Selects the update transport: `'polling'` (interval `getProgramAccounts`), `'websocket'` (program-account subscription), or `'grpc'` (Geyser/Laserstream). `commitment` defaults to `'processed'` if unset; `skipInitialLoad` (websocket/grpc only) skips the initial `fetch()` full snapshot; `resubTimeoutMs`/`logResubMessages` control websocket/grpc reconnect behavior; `resyncIntervalMs` (websocket/grpc only) triggers a periodic full `fetch()` resync on top of the live subscription. */
	subscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
				commitment?: Commitment;
		  }
		| {
				type: 'websocket';
				skipInitialLoad?: boolean;
				resubTimeoutMs?: number;
				logResubMessages?: boolean;
				resyncIntervalMs?: number;
				commitment?: Commitment;
		  }
		| {
				type: 'grpc';
				grpcConfigs: GrpcConfigs;
				skipInitialLoad?: boolean;
				resubTimeoutMs?: number;
				logResubMessages?: boolean;
				resyncIntervalMs?: number;
				commitment?: Commitment;
		  };
	/** Use the hand-written `decodeUser` fast-path decoder instead of the Anchor account coder. Defaults to `true`. */
	fastDecode?: boolean;
	/** For websocket/grpc transports, whether the subscriber's own subscription decodes accounts itself (`true`, default) or passes raw buffers for the caller to decode. */
	decodeData?: boolean;
	/** Widen the account filter from "has at least one order" to "any non-idle user", so idle-but-non-empty accounts are also tracked. Defaults to `false`. */
	fetchAllNonIdleUsers?: boolean;
};

/** Events emitted on `OrderSubscriber.eventEmitter`. */
export interface OrderSubscriberEvents {
	/** Fired when a `User` account update introduces one or more orders newly placed in `(previousObservedSlot, slot]`. */
	orderCreated: (
		account: UserAccount,
		updatedOrders: Order[],
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
	/** Fired whenever a `User` account update is accepted (i.e. not rejected by the staleness/slot check). */
	userUpdated: (
		account: UserAccount,
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
	/** Fired for every incoming update, even ones ultimately rejected as stale. */
	updateReceived: (
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
}
