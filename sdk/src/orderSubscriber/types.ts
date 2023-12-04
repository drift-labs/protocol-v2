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
};

export interface OrderSubscriberEvents {
	onUpdate: (
		account: UserAccount,
		updatedOrders: Order[],
		pubkey: PublicKey,
		slot: number
	) => void;
}
