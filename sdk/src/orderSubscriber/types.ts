import { Commitment, PublicKey } from '@solana/web3.js';
import { Order, UserAccount } from '../types';
import { DriftClient } from '../driftClient';

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
				commitment?: Commitment;
		  };
	fastDecode?: boolean;
};

export interface OrderSubscriberEvents {
	orderCreated: (
		account: UserAccount,
		updatedOrders: Order[],
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded'
	) => void;
	userUpdated: (
		account: UserAccount,
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded'
	) => void;
	updateReceived: (
		pubkey: PublicKey,
		slot: number,
		dataType: 'raw' | 'decoded'
	) => void;
}
