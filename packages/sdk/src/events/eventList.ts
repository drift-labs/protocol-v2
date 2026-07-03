import {
	EventType,
	EventMap,
	EventSubscriptionOrderDirection,
	SortFn,
} from './types';

class Node<Type extends EventType, Event extends EventMap[Type]> {
	constructor(
		public event: Event,
		public next?: Node<Type, Event>,
		public prev?: Node<Type, Event>
	) {}
}

/**
 * Fixed-capacity, sorted doubly-linked list of decoded events for a single
 * `EventType`, used internally by `EventSubscriber` to retain the most
 * recent `maxSize` events per type in the configured order.
 */
export class EventList<Type extends EventType> {
	size = 0;
	head?: Node<Type, EventMap[Type]>;
	tail?: Node<Type, EventMap[Type]>;

	/**
	 * @param eventType The `EventType` this list holds.
	 * @param maxSize Max events retained; once exceeded, the tail (least-recent per `sortFn`/`orderDirection`) is evicted.
	 * @param sortFn Comparator determining insertion order (see `getSortFn`).
	 * @param orderDirection Whether `'less than'` per `sortFn` sorts toward the head (`'asc'`) or tail (`'desc'`).
	 */
	public constructor(
		public eventType: Type,
		public maxSize: number,
		private sortFn: SortFn,
		private orderDirection: EventSubscriptionOrderDirection
	) {}

	/** Inserts `event` in sorted position (per `sortFn`/`orderDirection`), evicting the tail if this pushes the list over `maxSize`. */
	public insert(event: EventMap[Type]): void {
		this.size++;
		const newNode = new Node(event);
		if (this.head === undefined) {
			this.head = this.tail = newNode;
			return;
		}

		if (
			this.sortFn(this.head.event, newNode.event) ===
			(this.orderDirection === 'asc' ? 'less than' : 'greater than')
		) {
			this.head.prev = newNode;
			newNode.next = this.head;
			this.head = newNode;
		} else {
			let currentNode = this.head;
			while (
				currentNode.next !== undefined &&
				this.sortFn(currentNode.next.event, newNode.event) !==
					(this.orderDirection === 'asc' ? 'less than' : 'greater than')
			) {
				currentNode = currentNode.next;
			}

			newNode.next = currentNode.next;
			if (newNode.next !== undefined) {
				newNode.next.prev = newNode;
			} else {
				this.tail = newNode;
			}

			currentNode.next = newNode;
			newNode.prev = currentNode;
		}

		if (this.size > this.maxSize) {
			this.detach();
		}
	}

	/** Removes the tail node (the least-recent event per the list's order) and decrements `size`. No-ops on an empty list. */
	detach(): void {
		const node = this.tail;
		if (node === undefined) {
			return;
		}
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

		this.size--;
	}

	/** Materializes the list into a plain array, in current sort order. Allocates a new array — prefer iterating the list directly for hot paths. */
	toArray(): EventMap[Type][] {
		return Array.from(this);
	}

	*[Symbol.iterator]() {
		let node = this.head;
		while (node) {
			yield node.event;
			node = node.next;
		}
	}
}
