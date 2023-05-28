import { DriftClient } from '../driftClient';
import { UserAccount } from '../types';

export type OrderSubscriberConfig = {
	driftClient: DriftClient;
	subscriptionConfig: {
		type: 'polling';
		frequency: number;
	};
};

export type UserAccountMap = Map<
	string,
	{ slot: number; userAccount: UserAccount }
>;
