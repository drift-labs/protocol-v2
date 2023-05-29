import { DriftClient } from '../driftClient';

export type OrderSubscriberConfig = {
	driftClient: DriftClient;
	subscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
		  }
		| {
				type: 'websocket';
				skipInitialLoad?: boolean;
		  };
};
