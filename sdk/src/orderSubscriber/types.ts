import { Commitment, PublicKey } from '@solana/web3.js';
import { Order, UserAccount } from '../types';
import { DriftClient } from '../driftClient';
import { GrpcConfigs } from '../accounts/types';

export type OrderSubscriberConfig = {
	driftClient: DriftClient;
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
	fastDecode?: boolean;
	decodeData?: boolean;
};

export interface OrderSubscriberEvents {
	orderCreated: (
		account: UserAccount,
		updatedOrders: Order[],
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
	userUpdated: (
		account: UserAccount,
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
	updateReceived: (
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded' | 'buffer'
	) => void;
}
