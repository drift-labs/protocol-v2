import { ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';

export type ClearingHouseUserConfig = {
	accountSubscription?: ClearingHouseUserAccountSubscriptionConfig;
	clearingHouse: ClearingHouse;
	userAccountPublicKey: PublicKey;
};

export type ClearingHouseUserAccountSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
