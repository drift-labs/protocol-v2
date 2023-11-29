import { DriftClient } from './driftClient';
import { Commitment, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';

export type UserStatsConfig = {
	accountSubscription?: UserStatsSubscriptionConfig;
	driftClient: DriftClient;
	userStatsAccountPublicKey: PublicKey;
};

export type UserStatsSubscriptionConfig =
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
	  };
