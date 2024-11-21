import { Commitment, PublicKey, TransactionSignature } from '@solana/web3.js';
import {
	DepositRecord,
	FundingPaymentRecord,
	FundingRateRecord,
	LiquidationRecord,
	NewUserRecord,
	OrderActionRecord,
	OrderRecord,
	SettlePnlRecord,
	LPRecord,
	InsuranceFundRecord,
	SpotInterestRecord,
	InsuranceFundStakeRecord,
	CurveRecord,
	SwapRecord,
	SpotMarketVaultDepositRecord,
	SwiftOrderRecord,
	DeleteUserRecord,
} from '../index';
import { EventEmitter } from 'events';

export type EventSubscriptionOptions = {
	address?: PublicKey;
	eventTypes?: EventType[];
	maxEventsPerType?: number;
	orderBy?: EventSubscriptionOrderBy;
	orderDir?: EventSubscriptionOrderDirection;
	commitment?: Commitment;
	maxTx?: number;
	logProviderConfig?: LogProviderConfig;
	// when the subscription starts, client might want to backtrack and fetch old tx's
	// this specifies how far to backtrack
	untilTx?: TransactionSignature;
};

export const DefaultEventSubscriptionOptions: EventSubscriptionOptions = {
	eventTypes: [
		'DepositRecord',
		'FundingPaymentRecord',
		'LiquidationRecord',
		'OrderRecord',
		'OrderActionRecord',
		'FundingRateRecord',
		'NewUserRecord',
		'SettlePnlRecord',
		'LPRecord',
		'InsuranceFundRecord',
		'SpotInterestRecord',
		'InsuranceFundStakeRecord',
		'CurveRecord',
		'SwapRecord',
		'SpotMarketVaultDepositRecord',
		'SwiftOrderRecord',
		'DeleteUserRecord',
	],
	maxEventsPerType: 4096,
	orderBy: 'blockchain',
	orderDir: 'asc',
	commitment: 'confirmed',
	maxTx: 4096,
	logProviderConfig: {
		type: 'websocket',
	},
};

// Whether we sort events based on order blockchain produced events or client receives events
export type EventSubscriptionOrderBy = 'blockchain' | 'client';
export type EventSubscriptionOrderDirection = 'asc' | 'desc';

export type Event<T> = T & {
	txSig: TransactionSignature;
	slot: number;
	txSigIndex: number; // Unique index for each event inside a tx
};

export type WrappedEvent<Type extends EventType> = EventMap[Type] & {
	eventType: Type;
};

export type WrappedEvents = WrappedEvent<EventType>[];

export type EventMap = {
	DepositRecord: Event<DepositRecord>;
	FundingPaymentRecord: Event<FundingPaymentRecord>;
	LiquidationRecord: Event<LiquidationRecord>;
	FundingRateRecord: Event<FundingRateRecord>;
	OrderRecord: Event<OrderRecord>;
	OrderActionRecord: Event<OrderActionRecord>;
	SettlePnlRecord: Event<SettlePnlRecord>;
	NewUserRecord: Event<NewUserRecord>;
	LPRecord: Event<LPRecord>;
	InsuranceFundRecord: Event<InsuranceFundRecord>;
	SpotInterestRecord: Event<SpotInterestRecord>;
	InsuranceFundStakeRecord: Event<InsuranceFundStakeRecord>;
	CurveRecord: Event<CurveRecord>;
	SwapRecord: Event<SwapRecord>;
	SpotMarketVaultDepositRecord: Event<SpotMarketVaultDepositRecord>;
	SwiftOrderRecord: Event<SwiftOrderRecord>;
	DeleteUserRecord: Event<DeleteUserRecord>;
};

export type EventType = keyof EventMap;

export type DriftEvent =
	| Event<DepositRecord>
	| Event<FundingPaymentRecord>
	| Event<LiquidationRecord>
	| Event<FundingRateRecord>
	| Event<OrderRecord>
	| Event<OrderActionRecord>
	| Event<SettlePnlRecord>
	| Event<NewUserRecord>
	| Event<LPRecord>
	| Event<InsuranceFundRecord>
	| Event<SpotInterestRecord>
	| Event<InsuranceFundStakeRecord>
	| Event<CurveRecord>
	| Event<SwapRecord>
	| Event<SpotMarketVaultDepositRecord>
	| Event<SwiftOrderRecord>
	| Event<DeleteUserRecord>;

export interface EventSubscriberEvents {
	newEvent: (event: WrappedEvent<EventType>) => void;
}

export type SortFn = (
	currentRecord: EventMap[EventType],
	newRecord: EventMap[EventType]
) => 'less than' | 'greater than';

export type logProviderCallback = (
	txSig: TransactionSignature,
	slot: number,
	logs: string[],
	mostRecentBlockTime: number | undefined,
	txSigIndex: number | undefined
) => void;

export interface LogProvider {
	isSubscribed(): boolean;
	subscribe(
		callback: logProviderCallback,
		skipHistory?: boolean
	): Promise<boolean>;
	unsubscribe(external?: boolean): Promise<boolean>;
	eventEmitter?: EventEmitter;
}

export type LogProviderType = 'websocket' | 'polling' | 'events-server';

export type StreamingLogProviderConfig = {
	/// Max number of times to try reconnecting before failing over to fallback provider
	maxReconnectAttempts?: number;
	/// used for PollingLogProviderConfig on fallback
	fallbackFrequency?: number;
	/// used for PollingLogProviderConfig on fallback
	fallbackBatchSize?: number;
};

export type WebSocketLogProviderConfig = StreamingLogProviderConfig & {
	type: 'websocket';
	/// Max time to wait before resubscribing
	resubTimeoutMs?: number;
};

export type PollingLogProviderConfig = {
	type: 'polling';
	/// frequency to poll for new events
	frequency: number;
	/// max number of events to fetch per poll
	batchSize?: number;
};

export type EventsServerLogProviderConfig = StreamingLogProviderConfig & {
	type: 'events-server';
	/// url of the events server
	url: string;
};

export type LogProviderConfig =
	| WebSocketLogProviderConfig
	| PollingLogProviderConfig
	| EventsServerLogProviderConfig;
