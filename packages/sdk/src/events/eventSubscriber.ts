// EventSubscriber — see the class doc below for behavior. This module also
// wires together the LogProvider implementations (websocket/polling/events-server);
// see `events/types.ts` for the full event type union and `events/parse.ts` for log parsing.
import { Connection, PublicKey, TransactionSignature } from '@solana/web3.js';
import { Program } from '../isomorphic/anchor';
import {
	DefaultEventSubscriptionOptions,
	EventSubscriptionOptions,
	EventType,
	WrappedEvents,
	EventMap,
	LogProvider,
	EventSubscriberEvents,
	WebSocketLogProviderConfig,
	EventsServerLogProviderConfig,
	LogProviderType,
	StreamingLogProviderConfig,
	PollingLogProviderConfig,
	LogProviderConfig,
} from './types';
import { TxEventCache } from './txEventCache';
import { EventList } from './eventList';
import { PollingLogProvider } from './pollingLogProvider';
import { fetchLogs } from './fetchLogs';
import { WebSocketLogProvider } from './webSocketLogProvider';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { getSortFn } from './sort';
import { parseLogs } from './parse';
import { EventsServerLogProvider } from './eventsServerLogProvider';

/**
 * EventSubscriber — streams and decodes Velocity program events from
 * transaction logs (all records emitted via `emit!` from `state/events.rs`:
 * `DepositRecord`, `OrderActionRecord`, `LiquidationRecord`,
 * `FundingPaymentRecord`, etc. — see `EventMap` for the full set), via a
 * pluggable `LogProvider` (websocket, polling, or the Velocity events server),
 * and surfaces them both through per-type `EventList`s and a `'newEvent'`
 * `eventEmitter`.
 *
 * Ordering and dedup: each decoded event is tagged with `slot` and a
 * `txSigIndex` (its position among decoded events within the same
 * transaction); the per-event-type `EventList`s use these to sort either by
 * blockchain order (slot, then `txSigIndex`) or by client arrival order, per
 * `EventSubscriptionOptions.orderBy`. Whole transactions are deduped by
 * signature via an internal LRU (`TxEventCache`, sized by `options.maxTx`):
 * a transaction already in the cache is skipped entirely on a subsequent
 * delivery from the *same* log provider, which protects against a
 * websocket/polling provider redelivering the same tx. Events pushed by the
 * events-server provider bypass this cache (it dedups upstream and supplies
 * an authoritative `txSigIndex`). Event names are also normalized from the
 * `@coral-xyz/anchor` 0.32+ camelCase IDL form back to the PascalCase used by
 * `EventType`/`EventMap` before being matched against the subscribed types.
 */
export class EventSubscriber {
	private address: PublicKey;
	private eventListMap: Map<EventType, EventList<EventType>>;
	/** Case-insensitive lookup from decoded (camelCase) IDL event names to subscribed `EventType` keys. */
	private eventTypeByLowercaseName = new Map<string, EventType>();
	private txEventCache: TxEventCache;
	private awaitTxPromises = new Map<string, Promise<void>>();
	private awaitTxResolver = new Map<string, () => void>();
	private _logProvider?: LogProvider;
	private _currentProviderType: LogProviderType;
	public eventEmitter: StrictEventEmitter<EventEmitter, EventSubscriberEvents>;
	private lastSeenSlot: number | undefined;
	private lastSeenBlockTime: number | undefined;
	public lastSeenTxSig: string | undefined;

	private get logProvider(): LogProvider {
		if (!this._logProvider) {
			throw new Error(
				'EventSubscriber: logProvider accessed before initializeLogProvider()'
			);
		}
		return this._logProvider;
	}

	/**
	 * @param connection RPC connection used by the polling/websocket log providers and by `fetchPreviousTx`.
	 * @param program Anchor `Program` whose IDL coder decodes event logs (see `parse.ts`).
	 * @param options Subscription options; merged over `DefaultEventSubscriptionOptions` so any field left unset uses the default.
	 */
	public constructor(
		private connection: Connection,
		private program: Program,
		private options: EventSubscriptionOptions = DefaultEventSubscriptionOptions
	) {
		this.options = Object.assign({}, DefaultEventSubscriptionOptions, options);
		this.address = this.options.address ?? program.programId;
		this.txEventCache = new TxEventCache(this.options.maxTx);
		this.eventListMap = new Map<EventType, EventList<EventType>>();
		this.eventEmitter = new EventEmitter();

		this._currentProviderType = this.getLogProviderConfig().type;
		this.initializeLogProvider();
	}

	private getLogProviderConfig(): LogProviderConfig {
		if (this.options.logProviderConfig === undefined) {
			throw new Error('EventSubscriber: logProviderConfig is not set');
		}
		return this.options.logProviderConfig;
	}

	private getEventTypes(): EventType[] {
		if (this.options.eventTypes === undefined) {
			throw new Error('EventSubscriber: eventTypes is not set');
		}
		return this.options.eventTypes;
	}

	/** The `LogProviderType` currently in use. May differ from the configured type after a fallback failover (see `updateFallbackProviderType`). */
	get currentProviderType() {
		return this._currentProviderType;
	}

	private initializeLogProvider(subscribe = false) {
		const logProviderConfig = this.getLogProviderConfig();

		if (this._currentProviderType === 'websocket') {
			this._logProvider = new WebSocketLogProvider(
				// @ts-ignore
				this.connection,
				this.address,
				this.options.commitment ?? 'confirmed',
				(logProviderConfig as WebSocketLogProviderConfig).resubTimeoutMs
			);
		} else if (this._currentProviderType === 'polling') {
			const frequency =
				'frequency' in logProviderConfig
					? (logProviderConfig as PollingLogProviderConfig).frequency
					: (logProviderConfig as StreamingLogProviderConfig).fallbackFrequency;
			const batchSize =
				'batchSize' in logProviderConfig
					? (logProviderConfig as PollingLogProviderConfig).batchSize
					: (logProviderConfig as StreamingLogProviderConfig).fallbackBatchSize;

			this._logProvider = new PollingLogProvider(
				// @ts-ignore
				this.connection,
				this.address,
				this.options.commitment ?? 'confirmed',
				frequency,
				batchSize
			);
		} else if (this._currentProviderType === 'events-server') {
			this._logProvider = new EventsServerLogProvider(
				(logProviderConfig as EventsServerLogProviderConfig).url,
				this.getEventTypes(),
				this.options.address ? this.options.address.toString() : undefined
			);
		} else {
			throw new Error(
				`Invalid log provider type: ${this._currentProviderType}`
			);
		}

		if (subscribe) {
			this.logProvider.subscribe(
				(txSig, slot, logs, mostRecentBlockTime, txSigIndex) => {
					this.handleTxLogs(
						txSig,
						slot,
						logs,
						mostRecentBlockTime,
						this._currentProviderType === 'events-server',
						txSigIndex
					);
				},
				true
			);
		}
	}

	private populateInitialEventListMap() {
		const maxEventsPerType = this.options.maxEventsPerType;
		const orderBy = this.options.orderBy;
		const orderDir = this.options.orderDir;
		if (
			maxEventsPerType === undefined ||
			orderBy === undefined ||
			orderDir === undefined
		) {
			throw new Error(
				'EventSubscriber: maxEventsPerType, orderBy and orderDir must be set'
			);
		}
		for (const eventType of this.getEventTypes()) {
			this.eventListMap.set(
				eventType,
				new EventList(
					eventType,
					maxEventsPerType,
					getSortFn(orderBy, orderDir),
					orderDir
				)
			);
			this.eventTypeByLowercaseName.set(eventType.toLowerCase(), eventType);
		}
	}

	/**
	 * Implements fallback logic for reconnecting to LogProvider. Currently terminates at polling,
	 * could be improved to try the original type again after some cooldown.
	 */
	private updateFallbackProviderType(
		reconnectAttempts: number,
		maxReconnectAttempts: number
	) {
		if (reconnectAttempts < maxReconnectAttempts) {
			return;
		}

		let nextProviderType = this._currentProviderType;
		if (this._currentProviderType === 'events-server') {
			nextProviderType = 'websocket';
		} else if (this._currentProviderType === 'websocket') {
			nextProviderType = 'polling';
		} else if (this._currentProviderType === 'polling') {
			nextProviderType = 'polling';
		}

		console.log(
			`EventSubscriber: Failing over providerType ${this._currentProviderType} to ${nextProviderType}`
		);
		this._currentProviderType = nextProviderType;
	}

	/**
	 * Starts streaming events via the configured `LogProvider`. Idempotent —
	 * returns `true` immediately if already subscribed. (Re)initializes the
	 * per-event-type `EventList`s, so any events retained from a prior
	 * subscribe/unsubscribe cycle are discarded. For streaming providers
	 * (websocket, events-server), also wires up automatic failover: if the
	 * provider emits more than `maxReconnectAttempts` (default `Infinity`,
	 * i.e. never) reconnect attempts, the subscriber tears down and
	 * reinitializes with the next provider in the fallback chain
	 * (events-server → websocket → polling; polling has no further fallback).
	 * Does not itself backfill history — call `fetchPreviousTx` for that.
	 * @returns `true` once subscribed, or `false` if an error occurred while starting the subscription (logged to console, not thrown).
	 */
	public async subscribe(): Promise<boolean> {
		try {
			if (this.logProvider.isSubscribed()) {
				return true;
			}

			this.populateInitialEventListMap();

			if (
				this.getLogProviderConfig().type === 'websocket' ||
				this.getLogProviderConfig().type === 'events-server'
			) {
				const logProviderConfig =
					this.getLogProviderConfig() as StreamingLogProviderConfig;
				// `maxReconnectAttempts` is optional; when unset the original
				// `reconnectAttempts > undefined` comparison was always false, so
				// fall back to Infinity to preserve that never-trigger behavior.
				const maxReconnectAttempts =
					logProviderConfig.maxReconnectAttempts ?? Infinity;

				const eventEmitter = this.logProvider.eventEmitter;
				if (eventEmitter) {
					eventEmitter.on('reconnect', async (reconnectAttempts) => {
						if (reconnectAttempts > maxReconnectAttempts) {
							console.log(
								`EventSubscriber: Reconnect attempts ${reconnectAttempts}/${maxReconnectAttempts}, reconnecting...`
							);
							eventEmitter.removeAllListeners('reconnect');
							await this.unsubscribe();
							this.updateFallbackProviderType(
								reconnectAttempts,
								maxReconnectAttempts
							);
							this.initializeLogProvider(true);
						}
					});
				}
			}
			this.logProvider.subscribe(
				(txSig, slot, logs, mostRecentBlockTime, txSigIndex) => {
					this.handleTxLogs(
						txSig,
						slot,
						logs,
						mostRecentBlockTime,
						this._currentProviderType === 'events-server',
						txSigIndex
					);
				},
				true
			);

			return true;
		} catch (e) {
			console.error('Error fetching previous txs in event subscriber');
			console.error(e);
			return false;
		}
	}

	private handleTxLogs(
		txSig: TransactionSignature,
		slot: number,
		logs: string[],
		mostRecentBlockTime: number | undefined,
		fromEventsServer = false,
		txSigIndex: number | undefined = undefined
	): void {
		if (!fromEventsServer && this.txEventCache.has(txSig)) {
			return;
		}

		const wrappedEvents = this.parseEventsFromLogs(
			txSig,
			slot,
			logs,
			txSigIndex
		);

		for (const wrappedEvent of wrappedEvents) {
			const eventList = this.eventListMap.get(wrappedEvent.eventType);
			if (eventList === undefined) {
				throw new Error(
					`EventSubscriber: no EventList for eventType ${wrappedEvent.eventType}`
				);
			}
			eventList.insert(wrappedEvent);
		}

		// dont emit event till we've added all the events to the eventListMap
		for (const wrappedEvent of wrappedEvents) {
			this.eventEmitter.emit('newEvent', wrappedEvent);
		}

		if (this.awaitTxPromises.has(txSig)) {
			this.awaitTxPromises.delete(txSig);
			const resolver = this.awaitTxResolver.get(txSig);
			if (resolver !== undefined) {
				resolver();
			}
			this.awaitTxResolver.delete(txSig);
		}

		if (!this.lastSeenSlot || slot > this.lastSeenSlot) {
			this.lastSeenTxSig = txSig;
			this.lastSeenSlot = slot;
		}

		if (
			this.lastSeenBlockTime === undefined ||
			(mostRecentBlockTime !== undefined &&
				mostRecentBlockTime > this.lastSeenBlockTime)
		) {
			this.lastSeenBlockTime = mostRecentBlockTime;
		}

		this.txEventCache.add(txSig, wrappedEvents);
	}

	/**
	 * Backfills historical events by walking transactions for `address` via
	 * `getSignaturesForAddress`/`getTransaction`, newest-first, until either
	 * `options.untilTx` is reached or `options.maxTx` transactions have been
	 * fetched. Each fetched transaction is decoded and inserted into the
	 * event lists exactly like a live update, so `newEvent` fires for
	 * backfilled events too. No-ops if neither `untilTx` is set nor
	 * `fetchMax` is true — the subscriber does not backfill by default.
	 * @param fetchMax If true, backfill up to `maxTx` transactions even without an `untilTx` cutoff.
	 */
	public async fetchPreviousTx(fetchMax?: boolean): Promise<void> {
		if (!this.options.untilTx && !fetchMax) {
			return;
		}

		let txFetched = 0;
		let beforeTx: TransactionSignature | undefined = undefined;
		const untilTx: TransactionSignature | undefined = this.options.untilTx;
		const maxTx = this.options.maxTx;
		if (maxTx === undefined) {
			throw new Error('EventSubscriber: maxTx is not set');
		}
		while (txFetched < maxTx) {
			const response = await fetchLogs(
				// @ts-ignore
				this.connection,
				this.address,
				this.options.commitment === 'finalized' ? 'finalized' : 'confirmed',
				beforeTx,
				untilTx
			);

			if (response === undefined) {
				break;
			}

			txFetched += response.transactionLogs.length;
			beforeTx = response.earliestTx;

			for (const { txSig, slot, logs } of response.transactionLogs) {
				this.handleTxLogs(txSig, slot, logs, response.mostRecentBlockTime);
			}
		}
	}

	/**
	 * Stops the log provider and clears all in-memory state: the per-event-type
	 * `EventList`s, the `TxEventCache`, and any pending `awaitTx` promises
	 * (which are left unresolved/unrejected — callers awaiting a tx signature
	 * across an unsubscribe will hang).
	 * @returns Whatever the underlying `LogProvider.unsubscribe` returns.
	 */
	public async unsubscribe(): Promise<boolean> {
		this.eventListMap.clear();
		this.txEventCache.clear();
		this.awaitTxPromises.clear();
		this.awaitTxResolver.clear();

		return await this.logProvider.unsubscribe(true);
	}

	private parseEventsFromLogs(
		txSig: TransactionSignature,
		slot: number,
		logs: string[],
		txSigIndex: number | undefined
	): WrappedEvents {
		const records = [];
		// @ts-ignore
		const events = parseLogs(this.program, logs);
		let runningEventIndex = 0;
		for (const event of events) {
			// @coral-xyz/anchor 0.32+ converts IDL names to camelCase; match
			// case-insensitively so names with leading acronyms (LPSwapRecord →
			// lpSwapRecord) still resolve to their PascalCase EventType keys.
			const eventType = this.eventTypeByLowercaseName.get(
				event.name.toLowerCase()
			);
			if (eventType) {
				event.data.txSig = txSig;
				event.data.slot = slot;
				event.data.eventType = eventType;
				event.data.txSigIndex =
					txSigIndex !== undefined ? txSigIndex : runningEventIndex;
				records.push(event.data);
			}
			runningEventIndex++;
		}
		return records;
	}

	/**
	 * Resolves once the subscriber has observed and decoded events for `txSig`
	 * (immediately if it's already in the `TxEventCache`). Useful for waiting
	 * on the events of a transaction the caller just sent, before reading them
	 * via `getEventsByTx`. Never rejects; a transaction that never arrives
	 * (e.g. it failed, or the subscriber isn't subscribed) leaves the returned
	 * promise pending forever.
	 * @param txSig Signature to wait for.
	 * @returns A promise that resolves (with no value) once that transaction's events have been processed.
	 */
	public awaitTx(txSig: TransactionSignature): Promise<void> {
		const existingPromise = this.awaitTxPromises.get(txSig);
		if (existingPromise !== undefined) {
			return existingPromise;
		}

		if (this.txEventCache.has(txSig)) {
			return Promise.resolve();
		}

		const promise = new Promise<void>((resolve) => {
			this.awaitTxResolver.set(txSig, resolve);
		});
		this.awaitTxPromises.set(txSig, promise);
		return promise;
	}

	/**
	 * Returns the live `EventList` for `eventType` — the ordered, size-bounded
	 * (`maxEventsPerType`) linked list the subscriber inserts new events into.
	 * Prefer this over `getEventsArray` to iterate without copying.
	 * @param eventType Event type to look up; must be one of `options.eventTypes` (subscribed types).
	 * @returns The `EventList` for that type, or `undefined` if `eventType` was never subscribed (list not yet populated by `subscribe()`).
	 */
	public getEventList<Type extends keyof EventMap>(
		eventType: Type
	): EventList<Type> | undefined {
		return this.eventListMap.get(eventType) as EventList<Type> | undefined;
	}

	/**
	 * This requires the EventList be cast to an array, which requires reallocation of memory.
	 * Would bias to using getEventList over getEvents
	 *
	 * @param eventType Event type to snapshot.
	 * @returns All currently retained events of that type, in the `EventList`'s sort order (see `EventSubscriptionOptions.orderBy`/`orderDir`).
	 * @throws If `eventType` has no `EventList` (i.e. it isn't in `options.eventTypes`).
	 */
	public getEventsArray<Type extends EventType>(
		eventType: Type
	): EventMap[Type][] {
		const eventList = this.eventListMap.get(eventType);
		if (eventList === undefined) {
			throw new Error(
				`EventSubscriber: no EventList for eventType ${eventType}`
			);
		}
		return eventList.toArray() as EventMap[Type][];
	}

	/**
	 * Looks up the decoded events previously observed for a transaction.
	 * @param txSig Transaction signature to look up.
	 * @returns The wrapped events emitted by that transaction, or `undefined` if the transaction has aged out of the `TxEventCache` (bounded by `options.maxTx`) or was never observed.
	 */
	public getEventsByTx(txSig: TransactionSignature): WrappedEvents | undefined {
		return this.txEventCache.get(txSig);
	}
}
