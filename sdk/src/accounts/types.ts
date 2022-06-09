import {
	MarketAccount,
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
	OraclePriceData,
} from '..';
import { BN } from '@project-serum/anchor';

export interface AccountSubscriber<T> {
	accountAndSlot?: AccountAndSlot<T>;
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

	getStateAccountAndSlot(): AccountAndSlot<StateAccount>;
	getMarketAccountAndSlot(
		marketIndex: BN
	): AccountAndSlot<MarketAccount> | undefined;
	getOrderStateAccountAndSlot(): AccountAndSlot<OrderStateAccount>;

	getUserAccountAndSlot(): AccountAndSlot<UserAccount> | undefined;

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

	getUserAccountAndSlot(): AccountAndSlot<UserAccount>;
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

	getTokenAccountAndSlot(): AccountAndSlot<AccountInfo>;
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

	getOraclePriceData(): AccountAndSlot<OraclePriceData>;
}

export type AccountToPoll = {
	key: string;
	publicKey: PublicKey;
	eventType: string;
	callbackId?: string;
	mapKey?: number;
};

export type BufferAndSlot = {
	slot: number;
	buffer: Buffer | undefined;
};

export type AccountAndSlot<T> = {
	account: T;
	slot: number;
};
