import { DriftClient } from './driftClient';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';

export type DriftUserStatsConfig = {
	accountSubscription?: DriftUserStatsAccountSubscriptionConfig;
	driftClient: DriftClient;
	userStatsAccountPublicKey: PublicKey;
};

export type DriftUserStatsAccountSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
