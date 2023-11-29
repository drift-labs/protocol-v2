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

export type DriftClientConfig = {
	connection: Connection;
	wallet: IWallet;
	env?: DriftEnv;
	programID?: PublicKey;
	accountSubscription?: DriftClientSubscriptionConfig;
	opts?: ConfirmOptions;
	txSender?: TxSender;
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
};

export type DriftClientSubscriptionConfig =
	| {
			type: 'websocket';
			resubTimeoutMs?: number;
			commitment?: Commitment;
			useWhirligig?: boolean;
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
