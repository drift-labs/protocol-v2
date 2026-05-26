/**
 * Account subscription interfaces and types.
 *
 * VelocityClient uses a `VelocityClientAccountSubscriber` (WebSocket or polling) to keep
 * market, oracle, and state accounts cached in memory. `User` uses a `UserAccountSubscriber`
 * for the individual User account. All subscribers implement the interfaces defined here.
 *
 * Implementations: `webSocketDriftClientAccountSubscriber.ts` (default),
 * `pollingDriftClientAccountSubscriber.ts`, `bulkAccountLoader.ts` (batched RPC).
 */
import {
	SpotMarketAccount,
	PerpMarketAccount,
	OracleSource,
	StateAccount,
	UserAccount,
	UserStatsAccount,
	InsuranceFundStake,
	ConstituentAccount,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Context, PublicKey } from '@solana/web3.js';
import { Account } from '@solana/spl-token';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { User } from '../user';
import { Client, CommitmentLevel, LaserstreamConfig } from '../isomorphic/grpc';

export interface AccountSubscriber<T> {
	dataAndSlot?: DataAndSlot<T>;
	subscribe(onChange: (data: T) => void): Promise<void>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	setData(userAccount: T, slot?: number): void;
}

export interface ProgramAccountSubscriber<T> {
	subscribe(
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer
		) => void
	): Promise<void>;
	unsubscribe(): Promise<void>;
}

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export interface VelocityClientAccountEvents {
	stateAccountUpdate: (payload: StateAccount) => void;
	perpMarketAccountUpdate: (payload: PerpMarketAccount) => void;
	spotMarketAccountUpdate: (payload: SpotMarketAccount) => void;
	oraclePriceUpdate: (
		publicKey: PublicKey,
		oracleSource: OracleSource,
		data: OraclePriceData
	) => void;
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

/** @deprecated Use `VelocityClientAccountEvents` instead. `DriftClientAccountEvents` will be removed in a future major. */
export interface DriftClientAccountEvents extends VelocityClientAccountEvents {}

export interface VelocityClientAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, VelocityClientAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	addPerpMarket(marketIndex: number): Promise<boolean>;
	addSpotMarket(marketIndex: number): Promise<boolean>;
	addOracle(oracleInfo: OracleInfo): Promise<boolean>;
	setPerpOracleMap(): Promise<void>;
	setSpotOracleMap(): Promise<void>;

	getStateAccountAndSlot(): DataAndSlot<StateAccount>;
	getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined;
	getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[];
	getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined;
	getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[];
	getOraclePriceDataAndSlot(
		oracleId: string
	): DataAndSlot<OraclePriceData> | undefined;
	getOraclePriceDataAndSlotForPerpMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined;
	getOraclePriceDataAndSlotForSpotMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined;

	updateAccountLoaderPollingFrequency?: (pollingFrequency: number) => void;
}

/** @deprecated Use `VelocityClientAccountSubscriber` instead. `DriftClientAccountSubscriber` will be removed in a future major. */
export interface DriftClientAccountSubscriber
	extends VelocityClientAccountSubscriber {}

export enum DelistedMarketSetting {
	Unsubscribe,
	Subscribe,
	Discard,
}

export interface UserAccountEvents {
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserEvents {
	userUpdate: (payload: User) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(userAccount?: UserAccount): Promise<boolean>;
	fetch(): Promise<void>;
	updateData(userAccount: UserAccount, slot: number): void;
	unsubscribe(): Promise<void>;

	getUserAccountAndSlot(): DataAndSlot<UserAccount>;
}

export interface TokenAccountEvents {
	tokenAccountUpdate: (payload: Account) => void;
	update: void;
	error: (e: Error) => void;
}

export interface TokenAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getTokenAccountAndSlot(): DataAndSlot<Account>;
}

export interface InsuranceFundStakeAccountSubscriber {
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		InsuranceFundStakeAccountEvents
	>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getInsuranceFundStakeAccountAndSlot(): DataAndSlot<InsuranceFundStake>;
}

export interface InsuranceFundStakeAccountEvents {
	insuranceFundStakeAccountUpdate: (payload: InsuranceFundStake) => void;
	update: void;
	error: (e: Error) => void;
}

export interface OracleEvents {
	oracleUpdate: (payload: OraclePriceData) => void;
	update: void;
	error: (e: Error) => void;
}

export interface OracleAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, OracleEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getOraclePriceData(): DataAndSlot<OraclePriceData>;
}

export type AccountToPoll = {
	key: string;
	publicKey: PublicKey;
	eventType: string;
	callbackId?: string;
	mapKey?: number;
};

export type OraclesToPoll = {
	publicKey: PublicKey;
	source: OracleSource;
	callbackId?: string;
};

export type BufferAndSlot = {
	slot: number;
	buffer: Buffer | undefined;
};

export type DataAndSlot<T> = {
	data: T;
	slot: number;
};

export type ResubOpts = {
	resubTimeoutMs?: number;
	logResubMessages?: boolean;
	// New options for polling-based resubscription
	usePollingInsteadOfResub?: boolean;
	pollingIntervalMs?: number;
};

export interface UserStatsAccountEvents {
	userStatsAccountUpdate: (payload: UserStatsAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserStatsAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	isSubscribed: boolean;

	subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserStatsAccountAndSlot(): DataAndSlot<UserStatsAccount>;
}

type BaseGrpcConfigs = {
	endpoint: string;
	token: string;
	commitmentLevel?: CommitmentLevel;
	/**
	 * Whether to enable automatic reconnection on connection loss .
	 * Defaults to false, will throw on connection loss.
	 */
	enableReconnect?: boolean;
};

export type YellowstoneGrpcConfigs = BaseGrpcConfigs & {
	client?: 'yellowstone';
	channelOptions?: ConstructorParameters<typeof Client>[2];
};

export type LaserGrpcConfigs = BaseGrpcConfigs & {
	client: 'laser';
	channelOptions?: LaserstreamConfig['channelOptions'];
};

export type GrpcConfigs = YellowstoneGrpcConfigs | LaserGrpcConfigs;

export interface ConstituentAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, ConstituentAccountEvents>;
	isSubscribed: boolean;

	subscribe(constituentAccount?: ConstituentAccount): Promise<boolean>;
	sync(): Promise<void>;
	unsubscribe(): Promise<void>;
}

export interface ConstituentAccountEvents {
	onAccountUpdate: (
		account: ConstituentAccount,
		pubkey: PublicKey,
		slot: number
	) => void;
	update: void;
	error: (e: Error) => void;
}
