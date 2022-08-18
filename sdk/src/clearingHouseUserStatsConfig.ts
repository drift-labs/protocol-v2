import { ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';

export type ClearingHouseUserStatsConfig = {
	accountSubscription?: ClearingHouseUserStatsAccountSubscriptionConfig;
	clearingHouse: ClearingHouse;
	userStatsAccountPublicKey: PublicKey;
};

export type ClearingHouseUserStatsAccountSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
