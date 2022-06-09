import { Commitment, TransactionSignature } from '@solana/web3.js';
import {
	DepositRecord,
	FundingPaymentRecord,
	TradeRecord,
	LiquidationRecord,
	OrderRecord,
} from '../index';

export type EventSubscriptionOptions = {
	eventTypes?: EventType[];
	maxEventsPerType?: number;
	order?: EventSubscriptionOrder;
	commitment?: Commitment;
	maxTx?: number;
	logProviderConfig: LogProviderConfig;
};

export const DefaultEventSubscriptionOptions: EventSubscriptionOptions = {
	eventTypes: [
		'TradeRecord',
		'DepositRecord',
		'FundingPaymentRecord',
		'LiquidationRecord',
		'OrderRecord',
	],
	maxEventsPerType: 4096,
	order: 'blockchain',
	commitment: 'confirmed',
	maxTx: 4096,
	logProviderConfig: {
		type: 'websocket',
	},
};

// Whether we sort events based on order blockchain produced events or client receives events
export type EventSubscriptionOrder = 'blockchain' | 'client';

export type Event<Type extends EventType, Data extends EventMap[Type]> = {
	txSig: TransactionSignature;
	slot: number;
	type: Type;
	data: Data;
};

export type Events = Event<EventType, EventData>[];

export type EventMap = {
	DepositRecord: DepositRecord;
	TradeRecord: TradeRecord;
	FundingPaymentRecord: FundingPaymentRecord;
	LiquidationRecord: LiquidationRecord;
	OrderRecord: OrderRecord;
};
export type EventType = keyof EventMap;
export type EventData = EventMap[EventType];

export function clientSortFn(): 'before' {
	return 'before';
}

export function defaultBlockchainSortFn(
	currentRecord: Event<EventType, EventData>,
	newRecord: Event<EventType, EventData>
): 'before' | 'after' {
	return currentRecord.slot <= newRecord.slot ? 'before' : 'after';
}

export type logProviderCallback = (
	txSig: TransactionSignature,
	slot: number,
	logs: string[]
) => void;

export interface LogProvider {
	isSubscribed(): boolean;
	subscribe(callback: logProviderCallback): boolean;
	unsubscribe(): Promise<boolean>;
}

export type WebSocketLogProviderConfig = {
	type: 'websocket';
};

export type PollingLogProviderConfig = {
	type: 'polling';
};

export type LogProviderConfig =
	| WebSocketLogProviderConfig
	| PollingLogProviderConfig;
