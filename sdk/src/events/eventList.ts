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

export class EventList<Type extends EventType> {
	size = 0;
	head?: Node<Type, EventMap[Type]>;
	tail?: Node<Type, EventMap[Type]>;

	public constructor(
		public eventType: Type,
		public maxSize: number,
		private sortFn: SortFn,
		private orderDirection: EventSubscriptionOrderDirection
	) {}

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
			if (currentNode.next !== undefined) {
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

	detach(): void {
		const node = this.tail;
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
