import { Connection, PublicKey, TransactionSignature } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
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
	private logProvider: LogProvider;
	private currentProviderType: LogProviderType;
	public eventEmitter: StrictEventEmitter<EventEmitter, EventSubscriberEvents>;
	private lastSeenSlot: number;
	private lastSeenBlockTime: number | undefined;
	public lastSeenTxSig: string;

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

		this.currentProviderType = this.options.logProviderConfig.type;
		this.initializeLogProvider();
	}

	private initializeLogProvider(subscribe = false) {
		const logProviderConfig = this.options.logProviderConfig;

		if (this.currentProviderType === 'websocket') {
			this.logProvider = new WebSocketLogProvider(
				// @ts-ignore
				this.connection,
				this.address,
				this.options.commitment,
				(
					this.options.logProviderConfig as WebSocketLogProviderConfig
				).resubTimeoutMs
			);
		} else if (this.currentProviderType === 'polling') {
			const frequency =
				'frequency' in logProviderConfig
					? (logProviderConfig as PollingLogProviderConfig).frequency
					: (logProviderConfig as StreamingLogProviderConfig).fallbackFrequency;
			const batchSize =
				'batchSize' in logProviderConfig
					? (logProviderConfig as PollingLogProviderConfig).batchSize
					: (logProviderConfig as StreamingLogProviderConfig).fallbackBatchSize;

			this.logProvider = new PollingLogProvider(
				// @ts-ignore
				this.connection,
				this.address,
				this.options.commitment,
				frequency,
				batchSize
			);
		} else if (this.currentProviderType === 'events-server') {
			this.logProvider = new EventsServerLogProvider(
				(logProviderConfig as EventsServerLogProviderConfig).url,
				this.options.eventTypes,
				this.options.address ? this.options.address.toString() : undefined
			);
		} else {
			throw new Error(`Invalid log provider type: ${this.currentProviderType}`);
		}

		if (subscribe) {
			this.logProvider.subscribe(
				(txSig, slot, logs, mostRecentBlockTime, txSigIndex) => {
					this.handleTxLogs(
						txSig,
						slot,
						logs,
						mostRecentBlockTime,
						this.currentProviderType === 'events-server',
						txSigIndex
					);
				},
				true
			);
		}
	}

	private populateInitialEventListMap() {
		for (const eventType of this.options.eventTypes) {
			this.eventListMap.set(
				eventType,
				new EventList(
					eventType,
					this.options.maxEventsPerType,
					getSortFn(this.options.orderBy, this.options.orderDir),
					this.options.orderDir
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

		let nextProviderType = this.currentProviderType;
		if (this.currentProviderType === 'events-server') {
			nextProviderType = 'websocket';
		} else if (this.currentProviderType === 'websocket') {
			nextProviderType = 'polling';
		} else if (this.currentProviderType === 'polling') {
			nextProviderType = 'polling';
		}

		console.log(
			`EventSubscriber: Failing over providerType ${this.currentProviderType} to ${nextProviderType}`
		);
		this.currentProviderType = nextProviderType;
	}

	public async subscribe(): Promise<boolean> {
		try {
			if (this.logProvider.isSubscribed()) {
				return true;
			}

			this.populateInitialEventListMap();

			if (
				this.options.logProviderConfig.type === 'websocket' ||
				this.options.logProviderConfig.type === 'events-server'
			) {
				const logProviderConfig = this.options
					.logProviderConfig as StreamingLogProviderConfig;

				if (this.logProvider.eventEmitter) {
					this.logProvider.eventEmitter.on(
						'reconnect',
						async (reconnectAttempts) => {
							if (reconnectAttempts > logProviderConfig.maxReconnectAttempts) {
								console.log(
									`EventSubscriber: Reconnect attempts ${reconnectAttempts}/${logProviderConfig.maxReconnectAttempts}, reconnecting...`
								);
								this.logProvider.eventEmitter.removeAllListeners('reconnect');
								await this.unsubscribe();
								this.updateFallbackProviderType(
									reconnectAttempts,
									logProviderConfig.maxReconnectAttempts
								);
								this.initializeLogProvider(true);
							}
						}
					);
				}
			}
			this.logProvider.subscribe(
				(txSig, slot, logs, mostRecentBlockTime, txSigIndex) => {
					this.handleTxLogs(
						txSig,
						slot,
						logs,
						mostRecentBlockTime,
						this.currentProviderType === 'events-server',
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
			this.eventListMap.get(wrappedEvent.eventType).insert(wrappedEvent);
		}

		// dont emit event till we've added all the events to the eventListMap
		for (const wrappedEvent of wrappedEvents) {
			this.eventEmitter.emit('newEvent', wrappedEvent);
		}

		if (this.awaitTxPromises.has(txSig)) {
			this.awaitTxPromises.delete(txSig);
			this.awaitTxResolver.get(txSig)();
			this.awaitTxResolver.delete(txSig);
		}

		if (!this.lastSeenSlot || slot > this.lastSeenSlot) {
			this.lastSeenTxSig = txSig;
			this.lastSeenSlot = slot;
		}

		if (
			this.lastSeenBlockTime === undefined ||
			mostRecentBlockTime > this.lastSeenBlockTime
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
		let beforeTx: TransactionSignature = undefined;
		const untilTx: TransactionSignature = this.options.untilTx;
		while (txFetched < this.options.maxTx) {
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
			// @ts-ignore
			const expectRecordType = this.eventListMap.has(event.name);
			if (expectRecordType) {
				event.data.txSig = txSig;
				event.data.slot = slot;
				event.data.eventType = event.name;
				event.data.txSigIndex =
					txSigIndex !== undefined ? txSigIndex : runningEventIndex;
				records.push(event.data);
			}
			runningEventIndex++;
		}
		return records;
	}

	public awaitTx(txSig: TransactionSignature): Promise<void> {
		if (this.awaitTxPromises.has(txSig)) {
			return this.awaitTxPromises.get(txSig);
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
		return this.eventListMap.get(eventType).toArray() as EventMap[Type][];
	}

	public getEventsByTx(txSig: TransactionSignature): WrappedEvents | undefined {
		return this.txEventCache.get(txSig);
	}
}
