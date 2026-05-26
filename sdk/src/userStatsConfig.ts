import { VelocityClient } from './velocityClient';
import { Commitment, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { GrpcConfigs, UserStatsAccountSubscriber } from './accounts/types';
import { AtLeastOne } from './util/deprecatedAlias';

type UserStatsConfigBase = {
	accountSubscription?: UserStatsSubscriptionConfig;
	userStatsAccountPublicKey: PublicKey;
};

export type UserStatsConfig = UserStatsConfigBase &
	AtLeastOne<'velocityClient', 'driftClient', VelocityClient>;

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
