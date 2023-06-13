import { DriftClient } from './driftClient';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';

export type UserStatsConfig = {
	accountSubscription?: UserStatsSubscriptionConfig;
	driftClient: DriftClient;
	userStatsAccountPublicKey: PublicKey;
};

export type UserStatsSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  }
	| {
			type: 'custom';
	  };
