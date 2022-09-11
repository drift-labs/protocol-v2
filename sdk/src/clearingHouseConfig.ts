import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { IWallet } from './types';
import { BN } from '@project-serum/anchor';
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
	perpMarketIndexes?: BN[];
	spotMarketIndexes?: BN[];
	oracleInfos?: OracleInfo[];
	env?: DriftEnv;
	userStats?: boolean;
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
