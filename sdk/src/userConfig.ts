import { VelocityClient } from './velocityClient';
import { Commitment, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { GrpcConfigs, UserAccountSubscriber } from './accounts/types';
import { WebSocketProgramAccountSubscriber } from './accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from './types';
import { grpcMultiUserAccountSubscriber } from './accounts/grpcMultiUserAccountSubscriber';
import { AtLeastOne } from './util/deprecatedAlias';

type UserConfigBase = {
	accountSubscription?: UserSubscriptionConfig;
	userAccountPublicKey: PublicKey;
};

export type UserConfig = UserConfigBase &
	AtLeastOne<'velocityClient', 'driftClient', VelocityClient>;

export type UserSubscriptionConfig =
	| {
			type: 'grpc';
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			grpcConfigs: GrpcConfigs;
			grpcMultiUserAccountSubscriber?: grpcMultiUserAccountSubscriber;
	  }
	| {
			type: 'websocket';
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			commitment?: Commitment;
			programUserAccountSubscriber?: WebSocketProgramAccountSubscriber<UserAccount>;
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  }
	| {
			type: 'custom';
			userAccountSubscriber: UserAccountSubscriber;
	  };
