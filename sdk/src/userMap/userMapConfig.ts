import { Commitment, Connection } from '@solana/web3.js';
import { DriftClient } from '../driftClient';

// passed into UserMap.getUniqueAuthorities to filter users
export type UserAccountFilterCriteria = {
	// only return users that have open orders
	hasOpenOrders: boolean;
};

export type UserMapConfig = {
	driftClient: DriftClient;
	// connection object to use specifically for the UserMap. If undefined, will use the driftClient's connection
	connection?: Connection;
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
};
