import { Event, EventType, EventMap } from './types';

class Node<Type extends EventType, Data extends EventMap[Type]> {
	constructor(
		public event: Event<Type, Data>,
		public next?: Node<Type, Data>,
		public prev?: Node<Type, Data>
	) {}
}

export class EventList<Type extends EventType, Data extends EventMap[Type]> {
	size = 0;
	head?: Node<Type, Data>;
	tail?: Node<Type, Data>;

	public constructor(
		public maxSize: number,
		private sortFn: (
			currentNode: Event<Type, Data>,
			newNode: Event<Type, Data>
		) => 'before' | 'after'
	) {}

	public insert(event: Event<Type, Data>): void {
		this.size++;
		const newNode = new Node(event);
		if (this.head === undefined) {
			this.head = this.tail = newNode;
			return;
		}

		if (this.sortFn(this.head.event, newNode.event) === 'before') {
			this.head.prev = newNode;
			newNode.next = this.head;
			this.head = newNode;
		} else {
			let currentNode = this.head;
			while (
				currentNode.next !== undefined &&
				this.sortFn(currentNode.next.event, newNode.event) !== 'before'
			) {
				currentNode = currentNode.next;
			}

			newNode.next = currentNode.next;
			if (currentNode.next !== undefined) {
				newNode.next.prev = newNode;
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

	toArray(): Event<Type, Data>[] {
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
