import { Connection, PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { BN } from '@project-serum/anchor';

export type SerumMarketSubscriberConfig = {
	connection: Connection;
	programId: PublicKey;
	marketAddress: PublicKey;
	accountSubscription: {
		// enables use to add web sockets in the future
		type: 'polling';
		accountLoader: BulkAccountLoader;
	};
};
