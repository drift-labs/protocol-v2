import { Connection, TransactionSignature } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	DefaultEventSubscriptionOptions,
	EventSubscriptionOptions,
	EventType,
	Events,
	clientSortFn,
	defaultBlockchainSortFn,
	Event,
	EventMap,
	EventData,
	LogProvider,
} from './types';
import { TxEventCache } from './txEventCache';
import { EventList } from './eventList';
import { WebSocketLogProvider } from './webSocketLogProvider';

export class EventSubscriber {
	private subscriptionId: number;
	private eventListMap: Map<EventType, EventList<EventType, EventData>>;
	private txEventCache: TxEventCache;
	private awaitTxPromises = new Map<string, Promise<void>>();
	private awaitTxResolver = new Map<string, () => void>();
	private logProvider: LogProvider;

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
					options.order === 'client' ? clientSortFn : defaultBlockchainSortFn
				)
			);
		}

		this.logProvider = new WebSocketLogProvider(
			this.connection,
			this.program.programId,
			options.commitment
		);
	}

	public subscribe(): boolean {
		if (this.logProvider.isSubscribed()) {
			return true;
		}

		return this.logProvider.subscribe((txSig, slot, logs) => {
			if (this.txEventCache.has(txSig)) {
				return;
			}

			const events = this.parseEventsFromLogs(txSig, slot, logs);
			for (const event of events) {
				this.eventListMap.get(event.type).insert(event);
			}

			if (this.awaitTxPromises.has(txSig)) {
				this.awaitTxPromises.delete(txSig);
				this.awaitTxResolver.get(txSig)();
				this.awaitTxResolver.delete(txSig);
			}

			this.txEventCache.add(txSig, events);
		});
	}

	public async unsubscribe(): Promise<boolean> {
		await this.connection.removeOnLogsListener(this.subscriptionId);
		this.subscriptionId = undefined;
		return true;
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
