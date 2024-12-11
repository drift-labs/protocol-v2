import { Commitment, Connection, MemcmpFilter } from '@solana/web3.js';
import { DriftClient } from '../driftClient';
import { GrpcConfigs } from '../accounts/types';

// passed into UserMap.getUniqueAuthorities to filter users
export type UserAccountFilterCriteria = {
	// only return users that have open orders
	hasOpenOrders: boolean;
};

export type SyncConfig =
	| {
			type: 'default';
	  }
	| {
			type: 'paginated';
			chunkSize?: number;
			concurrencyLimit?: number;
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
				type: 'grpc';
				grpcConfigs: GrpcConfigs;
				resubTimeoutMs?: number;
				logResubMessages?: boolean;
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

	syncConfig?: SyncConfig;

	// Whether to throw an error if the userMap fails to sync. Defaults to true.
	throwOnFailedSync?: boolean;

	additionalFilters?: MemcmpFilter[];
};
