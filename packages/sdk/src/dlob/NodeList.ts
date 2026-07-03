import { isVariant, MarketTypeStr, Order } from '../types';
import { createNode, DLOBNode, DLOBNodeMap } from './DLOBNode';
import { BN } from '../isomorphic/anchor';

/** Ordering of a `NodeList`'s sort key: `'asc'` for ascending (e.g. asks, lowest price first), `'desc'` for descending (e.g. bids, highest price first). */
export type SortDirection = 'asc' | 'desc';

/**
 * Builds the key used to identify an order uniquely across a user's orders: `"{userAccount}-{orderId}"`.
 * Used as the map key in `NodeList.nodeMap` and to de-duplicate/merge fills in `DLOB`.
 *
 * @param orderId the order's `orderId` (unique per user account, not globally)
 * @param userAccount base58 pubkey string of the order's owner
 * @returns a string uniquely identifying the order within the DLOB
 */
export function getOrderSignature(
	orderId: number,
	userAccount: string
): string {
	return `${userAccount.toString()}-${orderId.toString()}`;
}

/** Implemented by anything that can produce a fresh `Generator<DLOBNode>` over its nodes, e.g. `NodeList` itself. */
export interface DLOBNodeGenerator {
	getGenerator(): Generator<DLOBNode>;
}

/**
 * A sorted, doubly-linked list of one order-node type (e.g. resting-limit asks) for one
 * market/side. Insertion walks the list from `head` to find the correct sorted position — O(n)
 * per insert — trading insert speed for cheap best-of-book access (`head`) and cheap iteration.
 * Backed by a `Map` (`nodeMap`) keyed by `getOrderSignature` for O(1) lookup/update/removal by
 * order id.
 */
export class NodeList<NodeType extends keyof DLOBNodeMap>
	implements DLOBNodeGenerator
{
	/** The best (first-sorted) node in the list, or `undefined` if empty. For a `'desc'`-sorted bid list this is the highest bid; for `'asc'`-sorted ask list, the lowest ask. */
	head?: DLOBNodeMap[NodeType];
	/** Number of nodes currently in the list. */
	length = 0;
	/** Nodes keyed by `getOrderSignature(orderId, userAccount)` for O(1) has/get/update/remove. */
	nodeMap = new Map<string, DLOBNodeMap[NodeType]>();

	/**
	 * @param nodeType which `DLOBNodeMap` node subclass this list holds
	 * @param sortDirection `'asc'` or `'desc'` — the direction new nodes are ordered from `head`
	 */
	constructor(
		private nodeType: NodeType,
		private sortDirection: SortDirection
	) {}

	/** Empties the list: clears `head`, resets `length` to 0, and clears `nodeMap`. */
	public clear() {
		this.head = undefined;
		this.length = 0;
		this.nodeMap.clear();
	}

	/**
	 * Inserts an order into its sorted position. No-ops if the order's status is not `open`, or
	 * if an order with the same signature (`userAccount` + `orderId`) is already present.
	 *
	 * @param order on-chain order to insert (ignored if not `open`)
	 * @param marketType the order's market type, passed through to `createNode`
	 * @param userAccount base58 pubkey string of the order's owner
	 * @param baseAssetAmount remaining base amount to track on the node, BASE_PRECISION (1e9); defaults to `order.baseAssetAmount`
	 */
	public insert(
		order: Order,
		marketType: MarketTypeStr,
		userAccount: string,
		baseAssetAmount?: BN
	): void {
		if (!isVariant(order.status, 'open')) {
			return;
		}

		const newNode = createNode(
			this.nodeType,
			order,
			userAccount,
			baseAssetAmount
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

		const nextNode = currentNode.next;
		newNode.next = nextNode;
		if (nextNode !== undefined) {
			nextNode.previous = newNode;
		}
		currentNode.next = newNode;
		newNode.previous = currentNode;
	}

	/**
	 * Whether `newNode` should be spliced in immediately before `currentNode` given the list's
	 * `sortDirection`. Ties on `sortValue` are broken by earlier `order.slot` (arrival order)
	 * going first, regardless of sort direction.
	 *
	 * @param currentNode the node being compared against
	 * @param newNode the node being inserted
	 * @returns true if `newNode` sorts strictly before `currentNode`
	 */
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

	/**
	 * Updates the existing node's order in place (e.g. after a partial fill changes
	 * `baseAssetAmountFilled`) and resets `haveFilled` to `false`. No-ops if the order isn't in
	 * this list. Note: this does **not** re-sort the node, so it must not be used to change the
	 * node's `sortValue` field (price/slot/trigger price) — remove and re-insert instead.
	 *
	 * @param order the order's new state
	 * @param userAccount base58 pubkey string of the order's owner
	 */
	public update(order: Order, userAccount: string): void {
		const orderId = getOrderSignature(order.orderId, userAccount);
		const node = this.nodeMap.get(orderId);
		if (node !== undefined) {
			Object.assign(node.order, order);
			node.haveFilled = false;
		}
	}

	/**
	 * Unlinks and removes the node matching `order`/`userAccount` from the list. No-ops if the
	 * order isn't present.
	 *
	 * @param order the order to remove (matched by `orderId`)
	 * @param userAccount base58 pubkey string of the order's owner
	 */
	public remove(order: Order, userAccount: string): void {
		const orderId = getOrderSignature(order.orderId, userAccount);
		const node = this.nodeMap.get(orderId);
		if (node !== undefined) {
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

	/** Yields every node from `head` to tail, in the list's sorted order. A fresh generator is created on each call, so concurrent iteration is safe as long as the list isn't mutated mid-iteration. */
	*getGenerator(): Generator<DLOBNode> {
		let node = this.head;
		while (node !== undefined) {
			yield node;
			node = node.next;
		}
	}

	/** Returns whether an order with this `orderId`/`userAccount` signature is present in the list. */
	public has(order: Order, userAccount: string): boolean {
		return this.nodeMap.has(getOrderSignature(order.orderId, userAccount));
	}

	/**
	 * Looks up a node directly by its precomputed `getOrderSignature` string.
	 *
	 * @param orderSignature signature as produced by `getOrderSignature`
	 * @returns the matching node, or `undefined` if not present
	 */
	public get(orderSignature: string): DLOBNodeMap[NodeType] | undefined {
		return this.nodeMap.get(orderSignature);
	}

	/** Debug helper: logs every node's `getLabel()` output to the console, in sorted order. */
	public print(): void {
		let currentNode = this.head;
		while (currentNode !== undefined) {
			console.log(currentNode.getLabel());
			currentNode = currentNode.next;
		}
	}

	/** Debug helper: logs the sort direction and the `head` node's `getLabel()` output (or `'---'` if the list is empty). */
	public printTop(): void {
		if (this.head) {
			console.log(this.sortDirection.toUpperCase(), this.head.getLabel());
		} else {
			console.log('---');
		}
	}
}
