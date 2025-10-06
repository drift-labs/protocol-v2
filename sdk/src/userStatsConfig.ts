import { DriftClient } from './driftClient';
import { Commitment, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { GrpcConfigs, UserStatsAccountSubscriber } from './accounts/types';

export type UserStatsConfig = {
	accountSubscription?: UserStatsSubscriptionConfig;
	driftClient: DriftClient;
	userStatsAccountPublicKey: PublicKey;
};

export type UserStatsSubscriptionConfig =
	| {
			type: 'websocket';
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			commitment?: Commitment;
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  }
	| {
			type: 'custom';
			userStatsAccountSubscriber: UserStatsAccountSubscriber;
	  }
	| {
			type: 'grpc';
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			grpcConfigs: GrpcConfigs;
	  };
