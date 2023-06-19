import { DriftClient } from './driftClient';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { UserAccountSubscriber } from './accounts/types';

export type UserConfig = {
	accountSubscription?: UserSubscriptionConfig;
	driftClient: DriftClient;
	userAccountPublicKey: PublicKey;
};

export type UserSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  }
	| {
			type: 'custom';
			userAccountSubscriber: UserAccountSubscriber;
	  };
