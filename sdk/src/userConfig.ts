import { DriftClient } from './driftClient';
import { Commitment, PublicKey } from '@solana/web3.js';
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
			resubTimeoutMs?: number;
			commitment?: Commitment;
			useWhirligig?: boolean;
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  }
	| {
			type: 'custom';
			userAccountSubscriber: UserAccountSubscriber;
	  };
