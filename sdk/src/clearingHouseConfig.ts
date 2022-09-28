import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { IWallet } from './types';
import { OracleInfo } from './oracles/types';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { DriftEnv } from './config';

export type ClearingHouseConfig = {
	connection: Connection;
	wallet: IWallet;
	programID: PublicKey;
	accountSubscription?: ClearingHouseSubscriptionConfig;
	opts?: ConfirmOptions;
	txSenderConfig?: TxSenderConfig;
	userIds?: number[];
	activeUserId?: number;
	perpMarketIndexes?: number[];
	spotMarketIndexes?: number[];
	oracleInfos?: OracleInfo[];
	env?: DriftEnv;
	userStats?: boolean;
	authority?: PublicKey; // explicitly pass an authority if signer is delegate
};

type ClearingHouseSubscriptionConfig =
	| {
			type: 'websocket';
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };

type TxSenderConfig = {
	type: 'retry';
	timeout?: number;
	retrySleep?: number;
	additionalConnections?: Connection[];
};
