import {
	DepositHistoryAccount,
	ExtendedCurveHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	StateAccount,
	TradeHistoryAccount,
	UserAccount,
	UserPositionsAccount,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

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
	update: void;
}

export type ClearingHouseAccountTypes =
	| 'tradeHistoryAccount'
	| 'depositHistoryAccount'
	| 'fundingPaymentHistoryAccount'
	| 'fundingRateHistoryAccount'
	| 'curveHistoryAccount'
	| 'liquidationHistoryAccount';

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
}

export interface UserAccountEvents {
	userAccountData: (payload: UserAccount) => void;
	userPositionsData: (payload: UserPositionsAccount) => void;
	update: void;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserAccount(): UserAccount;
	getUserPositionsAccount(): UserPositionsAccount;
}
