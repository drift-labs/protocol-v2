import {
	DepositHistoryAccount,
	ExtendedCurveHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	OrderHistoryAccount,
	OrderStateAccount,
	StateAccount,
	TradeHistoryAccount,
	UserAccount,
	UserOrdersAccount,
	UserPositionsAccount,
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

export interface AccountSubscriber<T> {
	data?: T;
	subscribe(onChange: (data: T) => void): Promise<void>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;
}

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export interface ClearingHouseAccountEvents {
	stateAccountUpdate: (payload: StateAccount) => void;
	marketsAccountUpdate: (payload: MarketsAccount) => void;
	fundingPaymentHistoryAccountUpdate: (
		payload: FundingPaymentHistoryAccount
	) => void;
	fundingRateHistoryAccountUpdate: (payload: FundingRateHistoryAccount) => void;
	tradeHistoryAccountUpdate: (payload: TradeHistoryAccount) => void;
	liquidationHistoryAccountUpdate: (payload: LiquidationHistoryAccount) => void;
	depositHistoryAccountUpdate: (payload: DepositHistoryAccount) => void;
	curveHistoryAccountUpdate: (payload: ExtendedCurveHistoryAccount) => void;
	orderHistoryAccountUpdate: (payload: OrderHistoryAccount) => void;
	orderStateAccountUpdate: (payload: OrderStateAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export type ClearingHouseAccountTypes =
	| 'tradeHistoryAccount'
	| 'depositHistoryAccount'
	| 'fundingPaymentHistoryAccount'
	| 'fundingRateHistoryAccount'
	| 'curveHistoryAccount'
	| 'liquidationHistoryAccount'
	| 'orderHistoryAccount';

export interface ClearingHouseAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	isSubscribed: boolean;

	optionalExtraSubscriptions: ClearingHouseAccountTypes[];

	subscribe(
		optionalSubscriptions?: ClearingHouseAccountTypes[]
	): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getStateAccount(): StateAccount;
	getMarketsAccount(): MarketsAccount;
	getTradeHistoryAccount(): TradeHistoryAccount;
	getDepositHistoryAccount(): DepositHistoryAccount;
	getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount;
	getFundingRateHistoryAccount(): FundingRateHistoryAccount;
	getCurveHistoryAccount(): ExtendedCurveHistoryAccount;
	getLiquidationHistoryAccount(): LiquidationHistoryAccount;
	getOrderStateAccount(): OrderStateAccount;
	getOrderHistoryAccount(): OrderHistoryAccount;

	type: ClearingHouseConfigType;
}

export type UserPublicKeys = {
	user: PublicKey;
	userPositions: PublicKey;
	userOrders: PublicKey | undefined;
};

export interface UserAccountEvents {
	userAccountData: (payload: UserAccount) => void;
	userPositionsData: (payload: UserPositionsAccount) => void;
	userOrdersData: (payload: UserOrdersAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserAccount(): UserAccount;
	getUserPositionsAccount(): UserPositionsAccount;
	getUserOrdersAccount(): UserOrdersAccount;
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

	getTokenAccount(): AccountInfo;
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

	getOraclePriceData(): OraclePriceData;
}

export type AccountToPoll = {
	key: string;
	publicKey: PublicKey;
	eventType: string;
	callbackId?: string;
};

export type AccountData = {
	slot: number;
	buffer: Buffer | undefined;
};
