import { isVariant, MarketTypeStr, Order } from '..';
import { createNode, DLOBNode, DLOBNodeMap } from './DLOBNode';

export type SortDirection = 'asc' | 'desc';

export function getOrderSignature(
	orderId: number,
	userAccount: string
): string {
	return `${userAccount.toString()}-${orderId.toString()}`;
}

export interface DLOBNodeGenerator {
	getGenerator(): Generator<DLOBNode>;
}

export class NodeList<NodeType extends keyof DLOBNodeMap>
	implements DLOBNodeGenerator
{
	head?: DLOBNodeMap[NodeType];
	length = 0;
	nodeMap = new Map<string, DLOBNodeMap[NodeType]>();

	constructor(
		private nodeType: NodeType,
		private sortDirection: SortDirection
	) {}

	public clear() {
		this.head = undefined;
		this.length = 0;
		this.nodeMap.clear();
	}

	public insert(
		order: Order,
		marketType: MarketTypeStr,
		userAccount: string,
		isUserProtectedMaker: boolean
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		const newNode = createNode(
			this.nodeType,
			order,
			userAccount,
			isUserProtectedMaker
		);

		const orderSignature = getOrderSignature(order.orderId, userAccount);
		if (this.nodeMap.has(orderSignature)) {
			return;
		}
		this.nodeMap.set(orderSignature, newNode);

		this.length += 1;

		if (this.head === undefined) {
			this.head = newNode;
			return;
		}

		if (this.prependNode(this.head, newNode)) {
			this.head.previous = newNode;
			newNode.next = this.head;
			this.head = newNode;
			return;
		}

		let currentNode = this.head;
		while (
			currentNode.next !== undefined &&
			!this.prependNode(currentNode.next, newNode)
		) {
			currentNode = currentNode.next;
		}

		newNode.next = currentNode.next;
		if (currentNode.next !== undefined) {
			newNode.next.previous = newNode;
		}
		currentNode.next = newNode;
		newNode.previous = currentNode;
	}

	prependNode(
		currentNode: DLOBNodeMap[NodeType],
		newNode: DLOBNodeMap[NodeType]
	): boolean {
		const currentOrder = currentNode.order;
		const newOrder = newNode.order;

		const currentOrderSortPrice = currentNode.sortValue;
		const newOrderSortPrice = newNode.sortValue;

		if (newOrderSortPrice.eq(currentOrderSortPrice)) {
			return newOrder.slot.lt(currentOrder.slot);
		}

		if (this.sortDirection === 'asc') {
			return newOrderSortPrice.lt(currentOrderSortPrice);
		} else {
			return newOrderSortPrice.gt(currentOrderSortPrice);
		}
	}

	public update(order: Order, userAccount: string): void {
		const orderId = getOrderSignature(order.orderId, userAccount);
		if (this.nodeMap.has(orderId)) {
			const node = this.nodeMap.get(orderId);
			Object.assign(node.order, order);
			node.haveFilled = false;
		}
	}

	public remove(order: Order, userAccount: string): void {
		const orderId = getOrderSignature(order.orderId, userAccount);
		if (this.nodeMap.has(orderId)) {
			const node = this.nodeMap.get(orderId);
			if (node.next) {
				node.next.previous = node.previous;
			}
			if (node.previous) {
				node.previous.next = node.next;
			}

			if (this.head && node.order.orderId === this.head.order.orderId) {
				this.head = node.next;
			}

			node.previous = undefined;
			node.next = undefined;

			this.nodeMap.delete(orderId);

			this.length--;
		}
	}

	*getGenerator(): Generator<DLOBNode> {
		let node = this.head;
		while (node !== undefined) {
			yield node;
			node = node.next;
		}
	}

	public has(order: Order, userAccount: string): boolean {
		return this.nodeMap.has(getOrderSignature(order.orderId, userAccount));
	}

	public get(orderSignature: string): DLOBNodeMap[NodeType] | undefined {
		return this.nodeMap.get(orderSignature);
	}

	public print(): void {
		let currentNode = this.head;
		while (currentNode !== undefined) {
			console.log(currentNode.getLabel());
			currentNode = currentNode.next;
		}
	}

	public printTop(): void {
		if (this.head) {
			console.log(this.sortDirection.toUpperCase(), this.head.getLabel());
		} else {
			console.log('---');
		}
	}
}
