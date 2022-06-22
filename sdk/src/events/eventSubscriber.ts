import { Connection, TransactionSignature } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	DefaultEventSubscriptionOptions,
	EventSubscriptionOptions,
	EventType,
	Events,
	Event,
	EventMap,
	EventData,
	LogProvider,
	EventSubscriberEvents,
} from './types';
import { TxEventCache } from './txEventCache';
import { EventList } from './eventList';
import { PollingLogProvider } from './pollingLogProvider';
import { fetchLogs } from './fetchLogs';
import { WebSocketLogProvider } from './webSocketLogProvider';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { getSortFn } from './sort';

export class EventSubscriber {
	private eventListMap: Map<EventType, EventList<EventType, EventData>>;
	private txEventCache: TxEventCache;
	private awaitTxPromises = new Map<string, Promise<void>>();
	private awaitTxResolver = new Map<string, () => void>();
	private logProvider: LogProvider;
	public eventEmitter: StrictEventEmitter<EventEmitter, EventSubscriberEvents>;

	public constructor(
		private connection: Connection,
		private program: Program,
		private options: EventSubscriptionOptions = DefaultEventSubscriptionOptions
	) {
		this.options = Object.assign({}, DefaultEventSubscriptionOptions, options);
		this.txEventCache = new TxEventCache(this.options.maxTx);
		this.eventListMap = new Map<EventType, EventList<EventType, EventData>>();
		for (const eventType of this.options.eventTypes) {
			this.eventListMap.set(
				eventType,
				new EventList<EventType, EventData>(
					this.options.maxEventsPerType,
					getSortFn(options.order, eventType)
				)
			);
		}
		this.eventEmitter = new EventEmitter();
		if (this.options.logProviderConfig.type === 'websocket') {
			this.logProvider = new WebSocketLogProvider(
				this.connection,
				this.program.programId,
				this.options.commitment
			);
		} else {
			this.logProvider = new PollingLogProvider(
				this.connection,
				this.program.programId,
				options.commitment,
				this.options.logProviderConfig.frequency
			);
		}
	}

	public subscribe(): boolean {
		if (this.logProvider.isSubscribed()) {
			return true;
		}

		this.fetchPreviousTx().catch((e) => {
			console.error('Error fetching previous txs in event subscriber');
			console.error(e);
		});

		return this.logProvider.subscribe((txSig, slot, logs) => {
			this.handleTxLogs(txSig, slot, logs);
		});
	}

	private handleTxLogs(
		txSig: TransactionSignature,
		slot: number,
		logs: string[]
	): void {
		if (this.txEventCache.has(txSig)) {
			return;
		}

		const events = this.parseEventsFromLogs(txSig, slot, logs);
		for (const event of events) {
			this.eventListMap.get(event.type).insert(event);
			this.eventEmitter.emit('newEvent', event);
		}

		if (this.awaitTxPromises.has(txSig)) {
			this.awaitTxPromises.delete(txSig);
			this.awaitTxResolver.get(txSig)();
			this.awaitTxResolver.delete(txSig);
		}

		this.txEventCache.add(txSig, events);
	}

	private async fetchPreviousTx(): Promise<void> {
		if (!this.options.untilTx) {
			return;
		}

		let txFetched = 0;
		let beforeTx: TransactionSignature = undefined;
		const untilTx: TransactionSignature = this.options.untilTx;
		while (txFetched < this.options.maxTx) {
			const response = await fetchLogs(
				this.connection,
				this.program.programId,
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
				this.handleTxLogs(txSig, slot, logs);
			}
		}
	}

	public async unsubscribe(): Promise<boolean> {
		return await this.logProvider.unsubscribe();
	}

	private parseEventsFromLogs(
		txSig: TransactionSignature,
		slot: number,
		logs: string[]
	): Events {
		const records = [];
		// @ts-ignore
		this.program._events._eventParser.parseLogs(logs, (event) => {
			const expectRecordType = this.eventListMap.has(event.name);
			if (expectRecordType) {
				records.push({
					txSig,
					slot,
					type: event.name,
					data: event.data,
				});
			}
		});
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

	public getEventList<Type extends keyof EventMap, Data extends EventMap[Type]>(
		eventType: Type
	): EventList<Type, Data> {
		return this.eventListMap.get(eventType) as EventList<Type, Data>;
	}

	/**
	 * This requires the EventList be cast to an array, which requires reallocation of memory.
	 * Would bias to using getEventList over getEvents
	 *
	 * @param eventType
	 */
	public getEventsArray<Type extends EventType, Data extends EventMap[Type]>(
		eventType: Type
	): Event<Type, Data>[] {
		return this.eventListMap.get(eventType).toArray() as Event<Type, Data>[];
	}

	public getEventsByTx(txSig: TransactionSignature): Events | undefined {
		return this.txEventCache.get(txSig);
	}
}
