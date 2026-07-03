/**
 * Account subscription interfaces and types.
 *
 * VelocityClient uses a `VelocityClientAccountSubscriber` (WebSocket or polling) to keep
 * market, oracle, and state accounts cached in memory. `User` uses a `UserAccountSubscriber`
 * for the individual User account. All subscribers implement the interfaces defined here.
 *
 * Implementations: `webSocketVelocityClientAccountSubscriber.ts` (default),
 * `pollingVelocityClientAccountSubscriber.ts`, `bulkAccountLoader.ts` (batched RPC).
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

/**
 * Common contract for a subscriber that tracks a single on-chain account of type `T`.
 * Implemented by the `WebSocketAccountSubscriber`/`WebSocketAccountSubscriberV2`,
 * `grpcAccountSubscriber`, and polling-loader-backed subscribers. `dataAndSlot` is
 * undefined until the first fetch/notification lands; once set, `data` and `slot`
 * are always updated together (see `DataAndSlot`) so a caller never sees data from
 * one slot paired with another.
 */
export interface AccountSubscriber<T> {
	/** Latest decoded account data and the slot it was observed at, or undefined before the first load. */
	dataAndSlot?: DataAndSlot<T>;
	/**
	 * Begins tracking the account, seeding `dataAndSlot` with an initial `fetch()` if not already
	 * set, then attaching a live update source (WebSocket/gRPC notification or accountLoader
	 * callback). Idempotent: calling again while already subscribed is a no-op.
	 * @param onChange Invoked with the newly decoded account data whenever a strictly newer slot's
	 * update is observed.
	 */
	subscribe(onChange: (data: T) => void): Promise<void>;
	/** Fetches the account once via RPC and updates `dataAndSlot` if the response's slot is newer than what's cached. */
	fetch(): Promise<void>;
	/** Tears down the live update source. Safe to call when not subscribed. */
	unsubscribe(): Promise<void>;

	/**
	 * Seeds or overwrites `dataAndSlot` without an RPC round trip. Used to inject data the caller
	 * already has (e.g. from a prior fetch elsewhere) before `subscribe()` runs its own fetch.
	 * @param userAccount Decoded account data to store.
	 * @param slot Slot the data was observed at; defaults to 0 (the oldest-possible sentinel) if omitted, so a later real update always wins.
	 */
	setData(userAccount: T, slot?: number): void;
}

/**
 * Contract for a subscriber that tracks every account matching a program-account filter
 * (e.g. all `User` accounts owned by the program), rather than one specific pubkey.
 * Implemented by `WebSocketProgramAccountSubscriber`, `WebSocketProgramAccountsSubscriberV2`,
 * `grpcProgramAccountSubscriber`, and `LaserstreamProgramAccountSubscriber`.
 */
export interface ProgramAccountSubscriber<T> {
	/**
	 * Subscribes to program-account change notifications matching the filters supplied at
	 * construction.
	 * @param onChange Invoked once per changed account with its pubkey, decoded data, the
	 * notification's `Context` (including `slot`), and the raw account buffer.
	 */
	subscribe(
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer
		) => void
	): Promise<void>;
	/** Tears down the underlying subscription. Safe to call when not subscribed. */
	unsubscribe(): Promise<void>;
}

/**
 * Thrown by every subscriber's `assertIsSubscribed()`-guarded getter (e.g.
 * `getUserAccountAndSlot`, `getStateAccountAndSlot`) when called before `subscribe()` has
 * completed. This is the uniform contract across all subscriber implementations in this
 * directory: never read cached account data without having subscribed first.
 */
export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

/**
 * Events emitted by a `VelocityClientAccountSubscriber` on its `eventEmitter`. `update` fires
 * after every individual account-specific event (state/market/oracle) as a generic "something
 * changed" signal; `error` surfaces underlying transport errors (e.g. RPC batch failures)
 * without unsubscribing.
 */
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

/**
 * Contract for the subscriber `VelocityClient` uses to keep `State`, `PerpMarket`,
 * `SpotMarket`, and oracle accounts cached in memory. See `webSocketVelocityClientAccountSubscriber.ts`
 * (default, one WebSocket subscription per account), `pollingVelocityClientAccountSubscriber.ts`
 * (single `BulkAccountLoader` batches all accounts via periodic `getMultipleAccounts`), and
 * `grpcVelocityClientAccountSubscriber.ts`/`grpcVelocityClientAccountSubscriberV2.ts` (gRPC
 * Geyser stream). Accessor contracts differ by shape: the guarded singleton getters
 * (`getStateAccountAndSlot`) throw `NotSubscribedError` until `subscribe()` has completed; the
 * per-market/oracle accessors return `undefined` when that entry isn't cached yet; and the
 * collection getters (`getMarketAccountsAndSlots`, etc.) are cache reads that return a
 * possibly-empty array.
 */
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

	/** Present only on polling-backed implementations; retunes the shared `BulkAccountLoader`'s poll interval (ms) for all accounts it batches. */
	updateAccountLoaderPollingFrequency?: (pollingFrequency: number) => void;
}

/**
 * Controls what a `VelocityClientAccountSubscriber` does with a perp market (and its oracle, if
 * unused elsewhere) once the on-chain market status becomes `delisted`.
 */
export enum DelistedMarketSetting {
	/** Drop the live subscription for the delisted market/oracle but keep the last-known data cached. */
	Unsubscribe,
	/** Keep subscribing to the delisted market/oracle as normal (no special handling). */
	Subscribe,
	/** Drop the subscription and remove the market/oracle from the subscriber's internal maps entirely. */
	Discard,
}

/** Events emitted by a `UserAccountSubscriber` on its `eventEmitter`. `update` fires alongside every `userAccountUpdate`. */
export interface UserAccountEvents {
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

/** Events emitted at the `User` (SDK wrapper) level, distinct from the lower-level `UserAccountEvents`. */
export interface UserEvents {
	userUpdate: (payload: User) => void;
	update: void;
	error: (e: Error) => void;
}

/**
 * Contract for the subscriber `User` uses to track a single `UserAccount`. Implementations:
 * `WebSocketUserAccountSubscriber` (default), `PollingUserAccountSubscriber` (via
 * `BulkAccountLoader`), `grpcUserAccountSubscriber`, `OneShotUserAccountSubscriber` (fetch-only,
 * ~1 RPC call), `BasicUserAccountSubscriber` (no network I/O, data supplied by the caller), and
 * `WebSocketProgramUserAccountSubscriber` (filters a shared program-account stream).
 */
export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	/**
	 * @param userAccount Optional pre-fetched account data to seed the subscriber with, skipping
	 * the initial RPC fetch.
	 */
	subscribe(userAccount?: UserAccount): Promise<boolean>;
	fetch(): Promise<void>;
	/**
	 * Applies an externally-obtained account update (e.g. relayed from a parent subscriber) if its
	 * slot is not older than the currently cached one, emitting `userAccountUpdate`/`update` on
	 * acceptance.
	 * @param userAccount Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	updateData(userAccount: UserAccount, slot: number): void;
	unsubscribe(): Promise<void>;

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined only if subscribed but no data has loaded yet. */
	getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined;
}

/** Events emitted by a `TokenAccountSubscriber` on its `eventEmitter`. */
export interface TokenAccountEvents {
	tokenAccountUpdate: (payload: Account) => void;
	update: void;
	error: (e: Error) => void;
}

/** Contract for tracking an SPL token account balance (e.g. a spot market vault or a user's token wallet). Implemented by `PollingTokenAccountSubscriber`. */
export interface TokenAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	/** Throws `NotSubscribedError` if not subscribed. */
	getTokenAccountAndSlot(): DataAndSlot<Account>;
}

/**
 * Contract for tracking an `InsuranceFundStake` account. Implementations:
 * `WebSocketInsuranceFundStakeAccountSubscriber` (default), `PollingInsuranceFundStakeAccountSubscriber`,
 * and `grpcInsuranceFundStakeAccountSubscriber`.
 */
export interface InsuranceFundStakeAccountSubscriber {
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		InsuranceFundStakeAccountEvents
	>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	/** Throws `NotSubscribedError` if not subscribed. */
	getInsuranceFundStakeAccountAndSlot():
		| DataAndSlot<InsuranceFundStake>
		| undefined;
}

/** Events emitted by an `InsuranceFundStakeAccountSubscriber` on its `eventEmitter`. */
export interface InsuranceFundStakeAccountEvents {
	insuranceFundStakeAccountUpdate: (payload: InsuranceFundStake) => void;
	update: void;
	error: (e: Error) => void;
}

/** Events emitted by an `OracleAccountSubscriber` on its `eventEmitter`. */
export interface OracleEvents {
	oracleUpdate: (payload: OraclePriceData) => void;
	update: void;
	error: (e: Error) => void;
}

/** Contract for tracking a single oracle account's decoded price data. Implemented by `PollingOracleAccountSubscriber` (via `BulkAccountLoader`). */
export interface OracleAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, OracleEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	/** Throws `NotSubscribedError` if not subscribed. */
	getOraclePriceData(): DataAndSlot<OraclePriceData>;
}

/** A `state`/`perpMarket`/`spotMarket` account registered with a `PollingVelocityClientAccountSubscriber`'s `BulkAccountLoader`. */
export type AccountToPoll = {
	/** Anchor account discriminator name, also used to route the decoded data and pick the emitted event. */
	key: 'state' | 'perpMarket' | 'spotMarket';
	publicKey: PublicKey;
	/** `VelocityClientAccountEvents` key emitted when this account changes. */
	eventType: string;
	/** `BulkAccountLoader` callback id, set once registered; used to remove the account later. */
	callbackId?: string;
	/** For `perpMarket`/`spotMarket`, the market index this account decodes to. */
	mapKey?: number;
};

/** An oracle account registered with a `PollingVelocityClientAccountSubscriber`'s `BulkAccountLoader`. */
export type OraclesToPoll = {
	publicKey: PublicKey;
	source: OracleSource;
	/** `BulkAccountLoader` callback id, set once registered; used to remove the oracle later. */
	callbackId?: string;
};

/** Raw account buffer paired with the slot it was fetched/observed at; the buffer is undefined if the account does not exist on-chain. */
export type BufferAndSlot = {
	slot: number;
	buffer: Buffer | undefined;
};

/**
 * A decoded account payload paired atomically with the slot it was observed at. Every
 * `AccountSubscriber`/getter in this directory updates `data` and `slot` together in a single
 * assignment, so a caller reading `dataAndSlot` never sees data from one slot mixed with a slot
 * number from another. `slot === 0` is the seeded sentinel used when data is injected via
 * `setData`/a constructor without a real fetch (e.g. `BasicUserAccountSubscriber`) — it is
 * always superseded once a real fetch or notification lands, since updates only apply when the
 * new slot is `>=` the cached one.
 */
export type DataAndSlot<T> = {
	data: T;
	slot: number;
};

/** Resubscription/polling-fallback tuning for WebSocket- and gRPC-backed subscribers. */
export type ResubOpts = {
	/**
	 * Milliseconds of inactivity (no notification) before the subscriber treats the stream as
	 * stalled and resubscribes (or starts polling, see `usePollingInsteadOfResub`). Should be at
	 * least 1000ms; smaller values log a warning. Leave undefined to disable the inactivity
	 * watchdog entirely.
	 */
	resubTimeoutMs?: number;
	/** Emits verbose `console.log`/`console.debug` diagnostics for resub/polling transitions. Defaults to false. */
	logResubMessages?: boolean;
	// New options for polling-based resubscription
	/**
	 * On inactivity timeout, poll via RPC to check for a missed update instead of immediately
	 * tearing down and recreating the WebSocket subscription. Defaults to false on the v1
	 * `WebSocketAccountSubscriber`; the V2 subscribers default this to `true`.
	 */
	usePollingInsteadOfResub?: boolean;
	/** Polling cadence in ms when `usePollingInsteadOfResub` is active. Defaults to 30000 (30s). */
	pollingIntervalMs?: number;
};

/** Events emitted by a `UserStatsAccountSubscriber` on its `eventEmitter`. */
export interface UserStatsAccountEvents {
	userStatsAccountUpdate: (payload: UserStatsAccount) => void;
	update: void;
	error: (e: Error) => void;
}

/**
 * Contract for the subscriber `UserStats` uses to track a single `UserStatsAccount`.
 * Implementations mirror `UserAccountSubscriber`: `WebSocketUserStatsAccountSubscriber` (default),
 * `PollingUserStatsAccountSubscriber`, `grpcUserStatsAccountSubscriber`,
 * `OneShotUserStatsAccountSubscriber`, and `BasicUserStatsAccountSubscriber`.
 */
export interface UserStatsAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	isSubscribed: boolean;

	/** @param userStatsAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch. */
	subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined only if subscribed but no data has loaded yet. */
	getUserStatsAccountAndSlot(): DataAndSlot<UserStatsAccount> | undefined;
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

/** gRPC Geyser config for the default Yellowstone (Triton/Dragon's Mouth-compatible) client. */
export type YellowstoneGrpcConfigs = BaseGrpcConfigs & {
	client?: 'yellowstone';
	channelOptions?: ConstructorParameters<typeof Client>[2];
};

/** gRPC Geyser config for the Helius LaserStream client (`LaserstreamProgramAccountSubscriber`). Requires the optional `helius-laserstream` peer dependency. */
export type LaserGrpcConfigs = BaseGrpcConfigs & {
	client: 'laser';
	channelOptions?: LaserstreamConfig['channelOptions'];
};

/** Union of supported gRPC Geyser client configs; the `client` discriminant selects Yellowstone vs. LaserStream. */
export type GrpcConfigs = YellowstoneGrpcConfigs | LaserGrpcConfigs;

/** Contract for tracking an LP-pool `ConstituentAccount`. `sync()` is the fetch/reconcile entry point (analogous to `fetch()` on other subscribers). */
export interface ConstituentAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, ConstituentAccountEvents>;
	isSubscribed: boolean;

	/** @param constituentAccount Optional pre-fetched account data to seed the subscriber with. */
	subscribe(constituentAccount?: ConstituentAccount): Promise<boolean>;
	sync(): Promise<void>;
	unsubscribe(): Promise<void>;
}

/** Events emitted by a `ConstituentAccountSubscriber` on its `eventEmitter`. */
export interface ConstituentAccountEvents {
	onAccountUpdate: (
		account: ConstituentAccount,
		pubkey: PublicKey,
		slot: number
	) => void;
	update: void;
	error: (e: Error) => void;
}
