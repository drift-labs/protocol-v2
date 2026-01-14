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
	SignedMsgOrderRecord,
	DeleteUserRecord,
	FuelSweepRecord,
	FuelSeasonRecord,
	InsuranceFundSwapRecord,
	TransferProtocolIfSharesToRevenuePoolRecord,
	LPMintRedeemRecord,
	LPSettleRecord,
	LPSwapRecord,
	LPBorrowLendDepositRecord,
} from '../types';
import { EventEmitter } from 'events';
import { IdlDiscriminator } from '@coral-xyz/anchor/dist/cjs/idl';

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
		'depositRecord',
		'fundingPaymentRecord',
		'liquidationRecord',
		'orderRecord',
		'orderActionRecord',
		'fundingRateRecord',
		'newUserRecord',
		'settlePnlRecord',
		'LPRecord',
		'insuranceFundRecord',
		'spotInterestRecord',
		'insuranceFundStakeRecord',
		'curveRecord',
		'swapRecord',
		'spotMarketVaultDepositRecord',
		'signedMsgOrderRecord',
		'deleteUserRecord',
		'fuelSweepRecord',
		'fuelSeasonRecord',
		'insuranceFundSwapRecord',
		'transferProtocolIfSharesToRevenuePoolRecord',
		'LPMintRedeemRecord',
		'LPSettleRecord',
		'LPSwapRecord',
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
	depositRecord: Event<DepositRecord>;
	fundingPaymentRecord: Event<FundingPaymentRecord>;
	liquidationRecord: Event<LiquidationRecord>;
	fundingRateRecord: Event<FundingRateRecord>;
	orderRecord: Event<OrderRecord>;
	orderActionRecord: Event<OrderActionRecord>;
	settlePnlRecord: Event<SettlePnlRecord>;
	newUserRecord: Event<NewUserRecord>;
	LPRecord: Event<LPRecord>;
	insuranceFundRecord: Event<InsuranceFundRecord>;
	spotInterestRecord: Event<SpotInterestRecord>;
	insuranceFundStakeRecord: Event<InsuranceFundStakeRecord>;
	curveRecord: Event<CurveRecord>;
	swapRecord: Event<SwapRecord>;
	spotMarketVaultDepositRecord: Event<SpotMarketVaultDepositRecord>;
	signedMsgOrderRecord: Event<SignedMsgOrderRecord>;
	deleteUserRecord: Event<DeleteUserRecord>;
	fuelSweepRecord: Event<FuelSweepRecord>;
	fuelSeasonRecord: Event<FuelSeasonRecord>;
	insuranceFundSwapRecord: Event<InsuranceFundSwapRecord>;
	transferProtocolIfSharesToRevenuePoolRecord: Event<TransferProtocolIfSharesToRevenuePoolRecord>;
	LPSettleRecord: Event<LPSettleRecord>;
	LPMintRedeemRecord: Event<LPMintRedeemRecord>;
	LPSwapRecord: Event<LPSwapRecord>;
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
	| Event<SignedMsgOrderRecord>
	| Event<DeleteUserRecord>
	| Event<FuelSweepRecord>
	| Event<FuelSeasonRecord>
	| Event<InsuranceFundSwapRecord>
	| Event<TransferProtocolIfSharesToRevenuePoolRecord>
	| Event<LPSettleRecord>
	| Event<LPMintRedeemRecord>
	| Event<LPSwapRecord>
	| Event<LPBorrowLendDepositRecord>
	| Event<CuUsage>;

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

export type CuUsageEvent = {
	discriminator: IdlDiscriminator;
	name: 'CuUsage';
	fields: [
		{
			name: 'instruction';
			type: 'string';
			index: false;
		},
		{
			name: 'cuUsage';
			type: 'u32';
			index: false;
		},
	];
};

export type CuUsage = {
	instruction: string;
	cuUsage: number;
};
