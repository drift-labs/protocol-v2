import { DriftClient } from './driftClient';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';

export type DriftUserConfig = {
	accountSubscription?: DriftUserAccountSubscriptionConfig;
	driftClient: DriftClient;
	userAccountPublicKey: PublicKey;
};

export type DriftUserAccountSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
