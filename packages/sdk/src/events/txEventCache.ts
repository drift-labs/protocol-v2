import { WrappedEvent, EventType } from './types';

class Node {
	constructor(
		public key: string,
		public value: WrappedEvent<EventType>[],
		public next?: Node,
		public prev?: Node
	) {}
}

// lru cache
/**
 * LRU cache of decoded events keyed by transaction signature, used by
 * `EventSubscriber` both to serve `getEventsByTx`/`awaitTx` and to dedup
 * redeliveries of the same transaction from a log provider. Evicts the
 * least-recently-used entry once `maxTx` is exceeded (`add()` refreshes an
 * existing key's recency by moving it back to the head).
 */
export class TxEventCache {
	size = 0;
	head?: Node;
	tail?: Node;
	cacheMap = new Map<string, Node>();

	/** @param maxTx Max number of transactions retained; defaults to 1024. */
	constructor(public maxTx = 1024) {}

	/** Inserts (or refreshes, if `key` already exists) the events for transaction `key` at the head, evicting the tail if this exceeds `maxTx`. */
	public add(key: string, events: WrappedEvent<EventType>[]): void {
		const existingNode = this.cacheMap.get(key);
		if (existingNode) {
			this.detach(existingNode);
			this.size--;
		} else if (this.size === this.maxTx) {
			const tail = this.tail;
			if (tail === undefined) {
				throw new Error(
					'TxEventCache.add: cache at capacity but tail is unset'
				);
			}
			this.cacheMap.delete(tail.key);
			this.detach(tail);
			this.size--;
		}

		// Write to head of LinkedList
		if (!this.head) {
			this.head = this.tail = new Node(key, events);
		} else {
			const node = new Node(key, events, this.head);
			this.head.prev = node;
			this.head = node;
		}

		// update cacheMap with LinkedList key and Node reference
		this.cacheMap.set(key, this.head);
		this.size++;
	}

	/** Whether transaction `key` is currently cached. */
	public has(key: string): boolean {
		return this.cacheMap.has(key);
	}

	/** @returns The cached events for transaction `key`, or `undefined` if not cached (never seen, or evicted). */
	public get(key: string): WrappedEvent<EventType>[] | undefined {
		return this.cacheMap.get(key)?.value;
	}

	detach(node: Node): void {
		if (node.prev !== undefined) {
			node.prev.next = node.next;
		} else {
			this.head = node.next;
		}

		if (node.next !== undefined) {
			node.next.prev = node.prev;
		} else {
			this.tail = node.prev;
		}
	}

	/** Empties the cache. */
	public clear(): void {
		this.head = undefined;
		this.tail = undefined;
		this.size = 0;
		this.cacheMap.clear();
	}
}
