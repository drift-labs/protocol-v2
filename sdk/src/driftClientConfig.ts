import {
	Commitment,
	ConfirmOptions,
	Connection,
	PublicKey,
	TransactionVersion,
} from '@solana/web3.js';
import { IWallet, TxParams } from './types';
import { OracleInfo } from './oracles/types';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { DriftEnv } from './config';
import { TxSender } from './tx/types';
import { TxHandler, TxHandlerConfig } from './tx/txHandler';
import { DelistedMarketSetting, GrpcConfigs } from './accounts/types';

export type DriftClientConfig = {
	connection: Connection;
	wallet: IWallet;
	env?: DriftEnv;
	programID?: PublicKey;
	accountSubscription?: DriftClientSubscriptionConfig;
	opts?: ConfirmOptions;
	txSender?: TxSender;
	txHandler?: TxHandler;
	subAccountIds?: number[];
	activeSubAccountId?: number;
	perpMarketIndexes?: number[];
	spotMarketIndexes?: number[];
	marketLookupTable?: PublicKey;
	oracleInfos?: OracleInfo[];
	userStats?: boolean;
	authority?: PublicKey; // explicitly pass an authority if signer is delegate
	includeDelegates?: boolean; // flag for whether to load delegate accounts as well
	authoritySubAccountMap?: Map<string, number[]>; // if passed this will override subAccountIds and includeDelegates
	skipLoadUsers?: boolean; // if passed to constructor, no user accounts will be loaded. they will load if updateWallet is called afterwards.
	txVersion?: TransactionVersion; // which tx version to use
	txParams?: TxParams; // default tx params to use
	enableMetricsEvents?: boolean;
	txHandlerConfig?: TxHandlerConfig;
	delistedMarketSetting?: DelistedMarketSetting;
	useHotWalletAdmin?: boolean;
};

export type DriftClientSubscriptionConfig =
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
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
