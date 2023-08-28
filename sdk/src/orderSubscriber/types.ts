import { PublicKey } from '@solana/web3.js';
import { Order, UserAccount } from '../types';
import { DriftClient } from '../driftClient';

export type OrderSubscriberConfig = {
	driftClient: DriftClient;
	subscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
		  }
		| {
				type: 'websocket';
				skipInitialLoad?: boolean;
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
