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
export class TxEventCache {
	size = 0;
	head?: Node;
	tail?: Node;
	cacheMap: { [key: string]: Node } = {};

	constructor(public maxTx = 1024) {}

	public add(key: string, events: WrappedEvent<EventType>[]): void {
		const existingNode = this.cacheMap[key];
		if (existingNode) {
			this.detach(existingNode);
			this.size--;
		} else if (this.size === this.maxTx) {
			delete this.cacheMap[this.tail.key];
			this.detach(this.tail);
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
		this.cacheMap[key] = this.head;
		this.size++;
	}

	public has(key: string): boolean {
		return this.cacheMap.hasOwnProperty(key);
	}

	public get(key: string): WrappedEvent<EventType>[] | undefined {
		return this.cacheMap[key]?.value;
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

	public clear(): void {
		this.head = undefined;
		this.tail = undefined;
		this.size = 0;
		this.cacheMap = {};
	}
}
