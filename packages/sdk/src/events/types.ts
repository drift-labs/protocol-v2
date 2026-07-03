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
	InsuranceFundRecord,
	SpotInterestRecord,
	InsuranceFundStakeRecord,
	AmmCurveChanged,
	SwapRecord,
	SpotMarketVaultDepositRecord,
	SignedMsgOrderRecord,
	DeleteUserRecord,
	LPMintRedeemRecord,
	LPSettleRecord,
	LPSwapRecord,
	LPBorrowLendDepositRecord,
	PerpMarketFeeSweepRecord,
	ProtocolFeeWithdrawRecord,
	RevenueShareSettleRecord,
	TransferFeeAndPnlPoolRecord,
} from '../types';
import { EventEmitter } from 'events';

/**
 * Configuration for `EventSubscriber`. Unset fields fall back to the matching
 * field in `DefaultEventSubscriptionOptions`.
 */
export type EventSubscriptionOptions = {
	/** Program/account whose logs are parsed for events. Defaults to the Velocity program ID. */
	address?: PublicKey;
	/** Event names to decode and retain; events not in this list are dropped even if present in the logs. */
	eventTypes?: EventType[];
	/** Max events retained per event type in the in-memory `EventList` (oldest evicted first once exceeded). */
	maxEventsPerType?: number;
	/** Whether `EventList`s are sorted by the order the blockchain produced events (`'blockchain'`, by slot/txSigIndex) or the order the client received them (`'client'`). */
	orderBy?: EventSubscriptionOrderBy;
	/** Sort direction applied on top of `orderBy`. */
	orderDir?: EventSubscriptionOrderDirection;
	/** Commitment level used for both the live log subscription and any `fetchPreviousTx` backfill. */
	commitment?: Commitment;
	/** Max number of past transactions to backfill via `fetchPreviousTx`, and the `TxEventCache` LRU size. */
	maxTx?: number;
	/** Which `LogProvider` implementation streams new events: websocket, polling, or the Velocity events-server. */
	logProviderConfig?: LogProviderConfig;
	/** When the subscription starts, backtrack and fetch historical transactions until this signature (exclusive) is reached. Only consulted by `fetchPreviousTx`. */
	untilTx?: TransactionSignature;
};

/**
 * Default `EventSubscriptionOptions`: all known event types (including the
 * fee-sweep/revenue-share/LP-borrow-lend records), 4096 events retained per
 * type, blockchain-order ascending sort, `confirmed` commitment, and a
 * websocket log provider.
 */
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
		'InsuranceFundRecord',
		'SpotInterestRecord',
		'InsuranceFundStakeRecord',
		'AmmCurveChanged',
		'SwapRecord',
		'SpotMarketVaultDepositRecord',
		'SignedMsgOrderRecord',
		'DeleteUserRecord',
		'LPMintRedeemRecord',
		'LPSettleRecord',
		'LPSwapRecord',
		'LPBorrowLendDepositRecord',
		'PerpMarketFeeSweepRecord',
		'ProtocolFeeWithdrawRecord',
		'RevenueShareSettleRecord',
		'TransferFeeAndPnlPoolRecord',
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

/**
 * `'blockchain'` sorts by the order the chain produced events (slot, then
 * `txSigIndex` within a tx) — stable across reconnects/replays. `'client'`
 * sorts purely by arrival order at this process, which is cheaper but not
 * reproducible if the client reconnects or replays history.
 */
export type EventSubscriptionOrderBy = 'blockchain' | 'client';

/** Direction applied on top of `EventSubscriptionOrderBy`: `'asc'` sorts oldest/lowest-order-key first, `'desc'` newest first. */
export type EventSubscriptionOrderDirection = 'asc' | 'desc';

/**
 * A decoded program event record `T` (e.g. `DepositRecord`, `OrderRecord`)
 * augmented with the transaction it was emitted in.
 */
export type Event<T> = T & {
	/** Signature of the transaction that emitted this event. */
	txSig: TransactionSignature;
	/** Slot the transaction landed in. */
	slot: number;
	/** Index of this event among all decoded events in the same transaction; used to break slot ties when sorting and for dedup. */
	txSigIndex: number;
};

/** An `Event` tagged with its `EventMap` key, as emitted on `EventSubscriber.eventEmitter`'s `'newEvent'`. */
export type WrappedEvent<Type extends EventType> = EventMap[Type] & {
	eventType: Type;
};

/** An array of `WrappedEvent`s of any `EventType`, e.g. as returned by `getEventsByTx`/`LogParser.parseEventsFromLogs`. */
export type WrappedEvents = WrappedEvent<EventType>[];

/**
 * Maps each on-chain event name (as declared in `state/events.rs` and emitted
 * via Anchor's `emit!`) to its decoded, transaction-augmented shape. See
 * `../types.ts` for each record's field-level precisions. Five entries were
 * newly wired in this parity pass: `LPBorrowLendDepositRecord` (LP pool
 * borrow/lend deposit or withdraw against a constituent, token-amount
 * precision per the constituent's spot market), `PerpMarketFeeSweepRecord`
 * (streaming fee-sweep drains from a perp market's pnl pool — insurance,
 * protocol, and AMM-provision cuts — quote-token amounts, `QUOTE_PRECISION`),
 * `ProtocolFeeWithdrawRecord` (admin withdrawal from a perp or spot market's
 * protocol fee pool, token-amount precision of the source spot market),
 * `RevenueShareSettleRecord` (builder/referrer revenue-share settlement, fee
 * amounts in `QUOTE_PRECISION`), and `TransferFeeAndPnlPoolRecord` (internal
 * transfer between a market's fee pool and pnl pool, `QUOTE_PRECISION`).
 */
export type EventMap = {
	DepositRecord: Event<DepositRecord>;
	FundingPaymentRecord: Event<FundingPaymentRecord>;
	LiquidationRecord: Event<LiquidationRecord>;
	FundingRateRecord: Event<FundingRateRecord>;
	OrderRecord: Event<OrderRecord>;
	OrderActionRecord: Event<OrderActionRecord>;
	SettlePnlRecord: Event<SettlePnlRecord>;
	NewUserRecord: Event<NewUserRecord>;
	InsuranceFundRecord: Event<InsuranceFundRecord>;
	SpotInterestRecord: Event<SpotInterestRecord>;
	InsuranceFundStakeRecord: Event<InsuranceFundStakeRecord>;
	AmmCurveChanged: Event<AmmCurveChanged>;
	SwapRecord: Event<SwapRecord>;
	SpotMarketVaultDepositRecord: Event<SpotMarketVaultDepositRecord>;
	SignedMsgOrderRecord: Event<SignedMsgOrderRecord>;
	DeleteUserRecord: Event<DeleteUserRecord>;
	LPSettleRecord: Event<LPSettleRecord>;
	LPMintRedeemRecord: Event<LPMintRedeemRecord>;
	LPSwapRecord: Event<LPSwapRecord>;
	/** LP pool borrow/lend deposit or withdraw against a constituent's spot market. */
	LPBorrowLendDepositRecord: Event<LPBorrowLendDepositRecord>;
	/** Streaming sweep of a perp market's accrued fee ledger into the insurance, protocol, and AMM fee pools. Amounts are quote-token, `QUOTE_PRECISION` (1e6). */
	PerpMarketFeeSweepRecord: Event<PerpMarketFeeSweepRecord>;
	/** Admin withdrawal from a perp or spot market's protocol fee pool to a recipient token account. */
	ProtocolFeeWithdrawRecord: Event<ProtocolFeeWithdrawRecord>;
	/** Builder/referrer fee revenue-share settlement for a market. Fee amounts are quote-token, `QUOTE_PRECISION` (1e6). */
	RevenueShareSettleRecord: Event<RevenueShareSettleRecord>;
	/** Internal transfer of quote token between a perp market's fee pool and pnl pool. */
	TransferFeeAndPnlPoolRecord: Event<TransferFeeAndPnlPoolRecord>;
};

/** Union of all decodable event names — the keys of `EventMap`. */
export type EventType = keyof EventMap;

/**
 * Union of every possible decoded event shape (all `EventMap` value types
 * plus the synthetic `CuUsage` event, which is not a program event and is
 * only produced by `parseLogsForCuUsage`, not by `EventSubscriber`).
 */
export type VelocityEvent =
	| Event<DepositRecord>
	| Event<FundingPaymentRecord>
	| Event<LiquidationRecord>
	| Event<FundingRateRecord>
	| Event<OrderRecord>
	| Event<OrderActionRecord>
	| Event<SettlePnlRecord>
	| Event<NewUserRecord>
	| Event<InsuranceFundRecord>
	| Event<SpotInterestRecord>
	| Event<InsuranceFundStakeRecord>
	| Event<AmmCurveChanged>
	| Event<SwapRecord>
	| Event<SpotMarketVaultDepositRecord>
	| Event<SignedMsgOrderRecord>
	| Event<DeleteUserRecord>
	| Event<LPSettleRecord>
	| Event<LPMintRedeemRecord>
	| Event<LPSwapRecord>
	| Event<LPBorrowLendDepositRecord>
	| Event<PerpMarketFeeSweepRecord>
	| Event<ProtocolFeeWithdrawRecord>
	| Event<RevenueShareSettleRecord>
	| Event<TransferFeeAndPnlPoolRecord>
	| Event<CuUsage>;

/** Events emitted on `EventSubscriber.eventEmitter`. */
export interface EventSubscriberEvents {
	/** Fired once per decoded event, after it has been inserted into the subscriber's `EventList` for its type. */
	newEvent: (event: WrappedEvent<EventType>) => void;
}

/**
 * Comparator used by `EventList` to keep events ordered. Returns whether
 * `newRecord` sorts before (`'less than'`) or after (`'greater than'`)
 * `currentRecord`; see `getSortFn` for the concrete `'blockchain'`/`'client'`
 * implementations.
 */
export type SortFn = (
	currentRecord: EventMap[EventType],
	newRecord: EventMap[EventType]
) => 'less than' | 'greater than';

/**
 * Callback a `LogProvider` invokes once per transaction containing raw
 * program logs, before they are decoded into typed events.
 * @param txSig Signature of the transaction the logs came from.
 * @param slot Slot the transaction landed in.
 * @param logs Raw log lines for the transaction.
 * @param mostRecentBlockTime Unix timestamp (seconds) of the most recent block seen by the provider, if known.
 * @param txSigIndex Explicit event index within the tx, if the provider can supply one (e.g. events-server); otherwise the consumer numbers events by decode order.
 */
export type logProviderCallback = (
	txSig: TransactionSignature,
	slot: number,
	logs: string[],
	mostRecentBlockTime: number | undefined,
	txSigIndex: number | undefined
) => void;

/**
 * Common interface implemented by each log transport (`WebSocketLogProvider`,
 * `PollingLogProvider`, `EventsServerLogProvider`) that `EventSubscriber`
 * drives to receive raw transaction logs.
 */
export interface LogProvider {
	/** Whether the provider currently has an active subscription/connection. */
	isSubscribed(): boolean;
	/**
	 * Starts streaming logs, invoking `callback` per transaction.
	 * @param skipHistory If true, only the most recent log (not full backlog) is fetched on initial subscribe, where supported.
	 * @returns `true` once the subscription is established.
	 */
	subscribe(
		callback: logProviderCallback,
		skipHistory?: boolean
	): Promise<boolean>;
	/**
	 * Tears down the subscription.
	 * @param external Whether this is a caller-initiated unsubscribe (as opposed to an internal one during a reconnect); suppresses auto-resubscribe when true.
	 */
	unsubscribe(external?: boolean): Promise<boolean>;
	/** Emits `'reconnect'` with the current attempt count when a streaming provider detects a stall and is about to resubscribe. Only set on streaming (websocket/events-server) providers. */
	eventEmitter?: EventEmitter;
}

/** Which `LogProvider` implementation backs an `EventSubscriber`. */
export type LogProviderType = 'websocket' | 'polling' | 'events-server';

/** Shared reconnect/fallback options for streaming (websocket, events-server) log providers. */
export type StreamingLogProviderConfig = {
	/** Max reconnect attempts before `EventSubscriber` fails over to the next provider in the chain (events-server → websocket → polling); default `Infinity` (never fails over). */
	maxReconnectAttempts?: number;
	/** Poll interval (ms) for the `PollingLogProviderConfig` used once failed over to polling. */
	fallbackFrequency?: number;
	/** `getTransaction` batch size for the `PollingLogProviderConfig` used once failed over to polling. */
	fallbackBatchSize?: number;
};

/** Configures `EventSubscriber` to stream events via `connection.onLogs`. */
export type WebSocketLogProviderConfig = StreamingLogProviderConfig & {
	type: 'websocket';
	/** Resubscribe if no log data arrives within this many ms; left unset, the websocket never auto-resubscribes. */
	resubTimeoutMs?: number;
};

/** Configures `EventSubscriber` to poll for new transactions via `getSignaturesForAddress`/`getTransaction` on an interval. */
export type PollingLogProviderConfig = {
	type: 'polling';
	/** Poll interval in milliseconds. */
	frequency: number;
	/** Max `getTransaction` calls batched per poll round-trip; defaults to 25 (see `fetchLogs`). */
	batchSize?: number;
};

/** Configures `EventSubscriber` to receive pre-decoded events pushed over a websocket from the Velocity-hosted events server, instead of raw RPC logs. */
export type EventsServerLogProviderConfig = StreamingLogProviderConfig & {
	type: 'events-server';
	/** Websocket URL of the Velocity events server. */
	url: string;
};

/** Discriminated union of the three supported log-transport configs; the `type` field selects which `LogProvider` is constructed. */
export type LogProviderConfig =
	| WebSocketLogProviderConfig
	| PollingLogProviderConfig
	| EventsServerLogProviderConfig;

/** IDL-style event descriptor used to synthesize the `CuUsage` pseudo-event decoded by `parseLogsForCuUsage`; not a real on-chain `#[event]`. */
export type CuUsageEvent = {
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

/** Compute-unit usage for one instruction, derived from `Program ... consumed N of M compute units` log lines (see `parseLogsForCuUsage`). Not emitted by the program itself. */
export type CuUsage = {
	/** Instruction name, as logged by `Program log: Instruction: <name>`. */
	instruction: string;
	/** Compute units consumed by that instruction. */
	cuUsage: number;
};
