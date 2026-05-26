/**
 * VelocityClientConfig — configuration types for constructing a {@link VelocityClient}.
 *
 * Key options: RPC connection, wallet/keypair, account subscription mode
 * (WebSocket vs polling), oracle client selection, transaction sender config,
 * and feature flags (activeSubAccountId, authority override).
 */
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
import { VelocityEnv } from './config';
import { TxSender } from './tx/types';
import { TxHandler, TxHandlerConfig } from './tx/txHandler';
import {
	GrpcConfigs,
	ResubOpts,
	DelistedMarketSetting,
} from './accounts/types';
import { Coder, Program } from './isomorphic/anchor';
import { WebSocketAccountSubscriber } from './accounts/webSocketAccountSubscriber';
import { WebSocketAccountSubscriberV2 } from './accounts/webSocketAccountSubscriberV2';
import { grpcVelocityClientAccountSubscriberV2 } from './accounts/grpcVelocityClientAccountSubscriberV2';
import { grpcVelocityClientAccountSubscriber } from './accounts/grpcVelocityClientAccountSubscriber';
import { grpcMultiUserAccountSubscriber } from './accounts/grpcMultiUserAccountSubscriber';
import { WebSocketProgramAccountSubscriber } from './accounts/webSocketProgramAccountSubscriber';
import { WebSocketVelocityClientAccountSubscriber } from './accounts/webSocketVelocityClientAccountSubscriber';
import { WebSocketVelocityClientAccountSubscriberV2 } from './accounts/webSocketVelocityClientAccountSubscriberV2';

export type VelocityClientConfig = {
	connection: Connection;
	wallet: IWallet;
	env?: VelocityEnv;
	programID?: PublicKey;
	accountSubscription?: VelocityClientSubscriptionConfig;
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

/** @deprecated Use `VelocityClientConfig` instead. `DriftClientConfig` will be removed in a future major. */
export type DriftClientConfig = VelocityClientConfig;

type GrpcVelocityClientAccountSubscriberCtor = new (
	grpcConfigs: GrpcConfigs,
	program: Program,
	perpMarketIndexes: number[],
	spotMarketIndexes: number[],
	oracleInfos: OracleInfo[],
	shouldFindAllMarketsAndOracles: boolean,
	delistedMarketSetting: DelistedMarketSetting
) =>
	| grpcVelocityClientAccountSubscriberV2
	| grpcVelocityClientAccountSubscriber;

type WsVelocityClientAccountSubscriberCtor = new (
	program: Program,
	perpMarketIndexes: number[],
	spotMarketIndexes: number[],
	oracleInfos: OracleInfo[],
	shouldFindAllMarketsAndOracles: boolean,
	delistedMarketSetting: DelistedMarketSetting
) =>
	| WebSocketVelocityClientAccountSubscriber
	| WebSocketVelocityClientAccountSubscriberV2;

export type VelocityClientSubscriptionConfig =
	| {
			type: 'grpc';
			grpcConfigs: GrpcConfigs;
			resubTimeoutMs?: number;
			logResubMessages?: boolean;
			velocityClientAccountSubscriber?: GrpcVelocityClientAccountSubscriberCtor;
			/** @deprecated Use `velocityClientAccountSubscriber` instead. `driftClientAccountSubscriber` will be removed in a future major. */
			driftClientAccountSubscriber?: GrpcVelocityClientAccountSubscriberCtor;
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
			velocityClientAccountSubscriber?: WsVelocityClientAccountSubscriberCtor;
			/** @deprecated Use `velocityClientAccountSubscriber` instead. `driftClientAccountSubscriber` will be removed in a future major. */
			driftClientAccountSubscriber?: WsVelocityClientAccountSubscriberCtor;
	  }
	| {
			type: 'polling';
			accountLoader: BulkAccountLoader;
	  };

/** @deprecated Use `VelocityClientSubscriptionConfig` instead. `DriftClientSubscriptionConfig` will be removed in a future major. */
export type DriftClientSubscriptionConfig = VelocityClientSubscriptionConfig;
