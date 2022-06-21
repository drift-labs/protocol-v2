import {
	BankAccount,
	MarketAccount,
	OracleSource,
	OrderStateAccount,
	StateAccount,
	UserAccount,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { AccountInfo } from '@solana/spl-token';
import {
	ClearingHouseConfigType,
	ClearingHouseUserConfigType,
	OracleInfo,
	OraclePriceData,
} from '..';
import { BN } from '@project-serum/anchor';

export interface AccountSubscriber<T> {
	dataAndSlot?: DataAndSlot<T>;
	subscribe(onChange: (data: T) => void): Promise<void>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;
}

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export interface ClearingHouseAccountEvents {
	stateAccountUpdate: (payload: StateAccount) => void;
	marketAccountUpdate: (payload: MarketAccount) => void;
	bankAccountUpdate: (payload: BankAccount) => void;
	oraclePriceUpdate: (publicKey: PublicKey, data: OraclePriceData) => void;
	orderStateAccountUpdate: (payload: OrderStateAccount) => void;
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface ClearingHouseAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	updateAuthority(newAuthority: PublicKey): Promise<boolean>;
	updateUserId(userId: number): Promise<boolean>;

	addMarket(marketIndex: BN): Promise<boolean>;
	addBank(bankIndex: BN): Promise<boolean>;
	addOracle(oracleInfo: OracleInfo): Promise<boolean>;

	getStateAccountAndSlot(): DataAndSlot<StateAccount>;
	getMarketAccountAndSlot(
		marketIndex: BN
	): DataAndSlot<MarketAccount> | undefined;
	getBankAccountAndSlot(bankIndex: BN): DataAndSlot<BankAccount> | undefined;
	getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined;
	getOrderStateAccountAndSlot(): DataAndSlot<OrderStateAccount>;

	getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined;

	type: ClearingHouseConfigType;
}

export type UserPublicKeys = {
	user: PublicKey;
};

export interface UserAccountEvents {
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserAccountAndSlot(): DataAndSlot<UserAccount>;
	type: ClearingHouseUserConfigType;
}

export interface TokenAccountEvents {
	tokenAccountUpdate: (payload: AccountInfo) => void;
	update: void;
	error: (e: Error) => void;
}

export interface TokenAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getTokenAccountAndSlot(): DataAndSlot<AccountInfo>;
}

export interface OracleEvents {
	oracleUpdate: (payload: OraclePriceData) => void;
	update: void;
	error: (e: Error) => void;
}

export interface OracleSubscriber {
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
