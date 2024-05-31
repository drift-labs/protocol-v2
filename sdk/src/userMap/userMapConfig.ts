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
				logResubMessages?: boolean;
				commitment?: Commitment;
		  };

	// True to skip the initial load of userAccounts via getProgramAccounts
	skipInitialLoad?: boolean;

	// True to include idle users when loading. Defaults to false to decrease # of accounts subscribed to.
	includeIdle?: boolean;

	// Whether to skip loading available perp/spot positions and open orders
	fastDecode?: boolean;

	// If true, will not do a full sync whenever StateAccount.numberOfSubAccounts changes.
	// default behavior is to do a full sync on changes.
	disableSyncOnTotalAccountsChange?: boolean;
};
