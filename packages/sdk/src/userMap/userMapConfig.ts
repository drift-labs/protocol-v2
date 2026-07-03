import { Commitment, Connection, MemcmpFilter } from '@solana/web3.js';
import { VelocityClient } from '../velocityClient';
import { GrpcConfigs } from '../accounts/types';

/** Passed into `UserMap.getUniqueAuthorities` to filter which users' authorities are returned. */
export type UserAccountFilterCriteria = {
	/** Only return users that have `hasOpenOrder` set on their `UserAccount`. */
	hasOpenOrders: boolean;
};

/**
 * Selects how `UserMap`/`UserStatsMap` bulk-load accounts on sync.
 * - `'default'`: a single `getProgramAccounts` call with server-side memcmp filters. Simple, but can hit RPC/node response-size limits when there are many accounts.
 * - `'paginated'`: a filtered `getProgramAccounts` prefetch for just the pubkeys, followed by chunked `getMultipleAccountsInfoAndContext` calls with bounded concurrency. More RPC calls, but scales to large account counts.
 */
export type SyncConfig =
	| {
			type: 'default';
	  }
	| {
			type: 'paginated';
			/** Number of accounts fetched per `getMultipleAccountsInfoAndContext` call. Defaults to 100. */
			chunkSize?: number;
			/** Max number of chunk-fetch tasks in flight at once. Defaults to 10. */
			concurrencyLimit?: number;
	  };

type UserMapConfigBase = {
	/** Connection to use specifically for this map. If omitted, uses the `VelocityClient`'s connection. */
	connection?: Connection;
	/** How the map keeps its accounts up to date after the initial sync. */
	subscriptionConfig:
		| {
				type: 'polling';
				/** Milliseconds between full re-syncs. */
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

	/** True to skip the initial load of userAccounts via getProgramAccounts */
	skipInitialLoad?: boolean;

	/** True to include idle users when loading. Defaults to false to decrease # of accounts subscribed to. */
	includeIdle?: boolean;

	/** Whether to skip loading available perp/spot positions and open orders */
	fastDecode?: boolean;

	/**
	 * If true, will not do a full sync whenever StateAccount.numberOfSubAccounts changes.
	 * default behavior is to do a full sync on changes.
	 */
	disableSyncOnTotalAccountsChange?: boolean;

	/** Bulk-load strategy for the initial sync and subsequent full syncs. Defaults to `{ type: 'default' }`. */
	syncConfig?: SyncConfig;

	/** Whether to throw an error if the userMap fails to sync. Defaults to false (errors are logged, not thrown). */
	throwOnFailedSync?: boolean;

	/** Whether to filter users by poolId. Defaults to undefined (all users, all pools). */
	filterByPoolId?: number;

	/** Extra memcmp filters ANDed onto the base `User`-account filter (and, unless `includeIdle`, the non-idle filter) for both the initial sync and the live subscription. */
	additionalFilters?: MemcmpFilter[];
};

export type UserMapConfig = UserMapConfigBase & {
	velocityClient: VelocityClient;
};
