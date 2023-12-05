import { Commitment, PublicKey } from '@solana/web3.js';
import { DriftClient } from '../driftClient';

// filter users that meet these criteria when passing into syncCallback
export type SyncCallbackCriteria = {
	// only sync users that have open orders
	hasOpenOrders: boolean;
};

export type UserMapConfig = {
	driftClient: DriftClient;
	subscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
				commitment?: Commitment;
		  }
		| {
				type: 'websocket';
				resubTimeoutMs?: number;
				commitment?: Commitment;
		  };

	// True to skip the initial load of userAccounts via getProgramAccounts
	skipInitialLoad?: boolean;

	// True to include idle users when loading. Defaults to false to decrease # of accounts subscribed to.
	includeIdle?: boolean;

	// Called after `sync` completes, will pass in the unique list of authorities. Useful for using it to sync UserStatsMap. noop if undefined
	syncCallback?: (authorities: PublicKey[]) => Promise<void>;

	// The criteria for the sync callback. Defaults to having no filters
	syncCallbackCriteria?: SyncCallbackCriteria;
};
