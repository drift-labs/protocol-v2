import {
	Commitment,
	ConfirmOptions,
	Connection,
	PublicKey,
	TransactionVersion,
} from '@solana/web3.js';
import { IWallet, TxParams, UserAccount } from './types';
import { OracleInfo } from './oracles/types';
import { BulkAccountLoader } from './accounts/bulkAccountLoader';
import { DriftEnv } from './config';
import { TxSender } from './tx/types';
import { TxHandler, TxHandlerConfig } from './tx/txHandler';
import {
	GrpcConfigs,
	ResubOpts,
	DelistedMarketSetting,
} from './accounts/types';
import { Coder, Program } from '@coral-xyz/anchor';
import { WebSocketAccountSubscriber } from './accounts/webSocketAccountSubscriber';
import { WebSocketAccountSubscriberV2 } from './accounts/webSocketAccountSubscriberV2';
import { grpcDriftClientAccountSubscriberV2 } from './accounts/grpcDriftClientAccountSubscriberV2';
import { grpcDriftClientAccountSubscriber } from './accounts/grpcDriftClientAccountSubscriber';
import { grpcMultiUserAccountSubscriber } from './accounts/grpcMultiUserAccountSubscriber';
import { WebSocketProgramAccountSubscriber } from './accounts/webSocketProgramAccountSubscriber';
import { WebSocketDriftClientAccountSubscriber } from './accounts/webSocketDriftClientAccountSubscriber';
import { WebSocketDriftClientAccountSubscriberV2 } from './accounts/webSocketDriftClientAccountSubscriberV2';

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
	/** @deprecated use marketLookupTables */
	marketLookupTable?: PublicKey;
	marketLookupTables?: PublicKey[];
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
	coder?: Coder;
};

export type DriftClientSubscriptionConfig =
	| {
			type: 'grpc';
			grpcConfigs: GrpcConfigs;
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			driftClientAccountSubscriber?: new (
				grpcConfigs: GrpcConfigs,
				program: Program,
				perpMarketIndexes: number[],
				spotMarketIndexes: number[],
				oracleInfos: OracleInfo[],
				shouldFindAllMarketsAndOracles: boolean,
				delistedMarketSetting: DelistedMarketSetting
			) =>
				| grpcDriftClientAccountSubscriberV2
				| grpcDriftClientAccountSubscriber;
			grpcMultiUserAccountSubscriber?: grpcMultiUserAccountSubscriber;
	  }
	| {
			type: 'websocket';
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			commitment?: Commitment;
			programUserAccountSubscriber?: WebSocketProgramAccountSubscriber<UserAccount>;
			perpMarketAccountSubscriber?: new (
				accountName: string,
				program: Program,
				accountPublicKey: PublicKey,
				decodeBuffer?: (buffer: Buffer) => any,
				resubOpts?: ResubOpts,
				commitment?: Commitment
			) => WebSocketAccountSubscriberV2<any> | WebSocketAccountSubscriber<any>;
			/** If you use V2 here, whatever you pass for perpMarketAccountSubscriber will be ignored and it will use v2 under the hood regardless */
			driftClientAccountSubscriber?: new (
				program: Program,
				perpMarketIndexes: number[],
				spotMarketIndexes: number[],
				oracleInfos: OracleInfo[],
				shouldFindAllMarketsAndOracles: boolean,
				delistedMarketSetting: DelistedMarketSetting
			) =>
				| WebSocketDriftClientAccountSubscriber
				| WebSocketDriftClientAccountSubscriberV2;
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };
