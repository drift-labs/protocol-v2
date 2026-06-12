/**
 * EventSubscriber — streams and parses Velocity program events from transaction logs.
 *
 * Decodes all program events (OrderActionRecord, DepositRecord, LiquidationRecord,
 * FundingPaymentRecord, etc.) from `state/events.rs` into typed TypeScript objects.
 * Supports WebSocket and polling log providers; events are surfaced via an EventEmitter.
 * See `events/types.ts` for the full event type union and `events/parse.ts` for log parsing.
 */
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

export class EventSubscriber {
	private address: PublicKey;
	private eventListMap: Map<EventType, EventList<EventType>>;
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
			// @coral-xyz/anchor 0.32+ converts IDL names to camelCase; normalize
			// back to PascalCase so EventType keys remain consistent.
			const pascalName =
				event.name.charAt(0).toUpperCase() + event.name.slice(1);
			// @ts-ignore
			const expectRecordType = this.eventListMap.has(pascalName);
			if (expectRecordType) {
				event.data.txSig = txSig;
				event.data.slot = slot;
				event.data.eventType = pascalName;
				event.data.txSigIndex =
					txSigIndex !== undefined ? txSigIndex : runningEventIndex;
				records.push(event.data);
			}
			runningEventIndex++;
		}
		return records;
	}

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

	public getEventList<Type extends keyof EventMap>(
		eventType: Type
	): EventList<Type> {
		return this.eventListMap.get(eventType) as EventList<Type>;
	}

	/**
	 * This requires the EventList be cast to an array, which requires reallocation of memory.
	 * Would bias to using getEventList over getEvents
	 *
	 * @param eventType
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

	public getEventsByTx(txSig: TransactionSignature): WrappedEvents | undefined {
		return this.txEventCache.get(txSig);
	}
}
