import {
	CurveHistory,
	DepositHistory,
	FundingPaymentHistory,
	FundingRateHistory,
	LiquidationHistory,
	Markets,
	State,
	TradeHistory,
	UserAccountData,
	UserPositionData,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

export interface AccountSubscriber<T> {
	data?: T;
	subscribe(onChange: (data: T) => void): Promise<void>;
	unsubscribe(): void;
}

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export interface ClearingHouseEvents {
	stateUpdate: (payload: State) => void;
	marketsUpdate: (payload: Markets) => void;
	fundingPaymentHistoryUpdate: (payload: FundingPaymentHistory) => void;
	fundingRateHistoryUpdate: (payload: FundingRateHistory) => void;
	tradeHistoryUpdate: (payload: TradeHistory) => void;
	liquidationHistoryUpdate: (payload: LiquidationHistory) => void;
	depositHistoryUpdate: (payload: DepositHistory) => void;
	curveHistoryUpdate: (payload: CurveHistory) => void;
	update: void;
}

export interface ClearingHouseAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	unsubscribe(): Promise<void>;

	getState(): State;
	getMarkets(): Markets;
	getTradeHistory(): TradeHistory;
	getDepositHistory(): DepositHistory;
	getFundingPaymentHistory(): FundingPaymentHistory;
	getFundingRateHistory(): FundingRateHistory;
	getCurveHistory(): CurveHistory;
	getLiquidationHistory(): LiquidationHistory;
}

export interface UserAccountEvents {
	userAccountData: (payload: UserAccountData) => void;
	userPositionsData: (payload: UserPositionData) => void;
	update: void;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	unsubscribe(): Promise<void>;

	getUserAccountData(): UserAccountData;
	getUserPositionsData(): UserPositionData;
}
