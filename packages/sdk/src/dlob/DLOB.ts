/**
 * DLOB — Decentralized Limit Order Book.
 *
 * Maintains an in-memory order book built from on-chain `User` accounts.
 * Used by keeper bots to identify the best maker orders to match against taker fills.
 *
 * Key types:
 *   `DLOBNode`        — a single order node with price/size/user info (DLOBNode.ts)
 *   `DLOBSubscriber`  — subscribes to on-chain accounts and keeps the DLOB live (DLOBSubscriber.ts)
 *   `NodeList`        — sorted linked list of DLOBNodes per side/market (NodeList.ts)
 *   `orderBookLevels.ts`    — aggregated L2/L3 book level construction for quoting
 */
import { getOrderSignature, NodeList } from './NodeList';
import { BN } from '../isomorphic/anchor';
import {
	BASE_PRECISION,
	BN_MAX,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { decodeName } from '../userName';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from './DLOBNode';
import { VelocityClient } from '../velocityClient';
import {
	calculateOrderBaseAssetAmount,
	getLimitPrice,
	isOrderExpired,
	isRestingLimitOrder,
	isTriggered,
	mustBeTriggered,
} from '../math/orders';
import {
	getVariant,
	isOneOfVariant,
	isVariant,
	MarketType,
	MarketTypeStr,
	Order,
	PerpMarketAccount,
	PositionDirection,
	SpotMarketAccount,
	StateAccount,
} from '../types';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import { SlotSubscriber } from '../slot/SlotSubscriber';
import { UserMap } from '../userMap/userMap';
import { PublicKey } from '@solana/web3.js';
import { ammPaused, exchangePaused, fillPaused } from '../math/exchangeStatus';
import {
	createL2Levels,
	getL2GeneratorFromDLOBNodes,
	L2OrderBook,
	L2OrderBookGenerator,
	L3Level,
	L3OrderBook,
	mergeL2LevelGenerators,
} from './orderBookLevels';
import { isFallbackAvailableLiquiditySource } from '../math/auction';
import { convertToNumber } from '../math/conversion';

/** An on-chain order paired with the pubkey of its owning `User` account. */
export type DLOBOrder = { user: PublicKey; order: Order };
/** A list of `DLOBOrder`s, e.g. the flattened output of `DLOB.getDLOBOrders`. */
export type DLOBOrders = DLOBOrder[];

/** The full set of sorted `NodeList`s the DLOB maintains for one market, one per order category and side. */
export type MarketNodeLists = {
	restingLimit: {
		ask: NodeList<'restingLimit'>;
		bid: NodeList<'restingLimit'>;
	};
	floatingLimit: {
		ask: NodeList<'floatingLimit'>;
		bid: NodeList<'floatingLimit'>;
	};
	takingLimit: {
		ask: NodeList<'takingLimit'>;
		bid: NodeList<'takingLimit'>;
	};
	market: {
		ask: NodeList<'market'>;
		bid: NodeList<'market'>;
	};
	trigger: {
		above: NodeList<'trigger'>;
		below: NodeList<'trigger'>;
	};
	signedMsg: {
		ask: NodeList<'signedMsg'>;
		bid: NodeList<'signedMsg'>;
	};
};

type OrderBookCallback = () => void;

/**
 *  Receives a DLOBNode and is expected to return true if the node should
 *  be taken into account when generating, or false otherwise.
 *
 * Currently used in functions that rely on getBestNode
 */
export type DLOBFilterFcn = (node: DLOBNode) => boolean;

/** A taker node paired with the maker node(s) it should be filled against. `makerNodes` is empty when the fill is expected to route through fallback (e.g. vAMM) liquidity or is an expiration/cancellation rather than a maker match. */
export type NodeToFill = {
	node: DLOBNode;
	makerNodes: DLOBNode[];
};

/** A trigger order whose `triggerPrice` has been crossed and is ready to be triggered on-chain. */
export type NodeToTrigger = {
	node: TriggerOrderNode;
};

const SUPPORTED_ORDER_TYPES = [
	'market',
	'limit',
	'triggerMarket',
	'triggerLimit',
	'oracle',
];

function getOrderOrThrow(node: DLOBNode): Order {
	if (!node.order) {
		throw new Error('DLOBNode must have an order');
	}
	return node.order;
}

function getUserAccountOrThrow(node: DLOBNode): string {
	if (node.userAccount === undefined) {
		throw new Error('DLOBNode must have a userAccount');
	}
	return node.userAccount;
}

/**
 * In-memory order book. Indexes every open order it is given into per-market, per-side sorted
 * `NodeList`s (see `MarketNodeLists`), and provides the crossing/fill-finding logic
 * (`findNodesToFill`) and aggregated book views (`getL2`/`getL3`) that keepers and clients use to
 * predict and drive on-chain fills. A `DLOB` instance is normally built once per slot (e.g. via
 * `initFromUserMap`) rather than mutated indefinitely, since state changes (`insertOrder`,
 * `delete`) must be paired with the caller's own bookkeeping of what's already been applied.
 */
export class DLOB {
	/** Order signatures (`getOrderSignature`) currently open, keyed by market type (`'perp'`/`'spot'`). */
	openOrders = new Map<MarketTypeStr, Set<string>>();
	/** Every market's `MarketNodeLists`, keyed by market type then market index. */
	orderLists = new Map<MarketTypeStr, Map<number, MarketNodeLists>>();
	/** The highest slot `updateRestingLimitOrders` has processed; used to skip redundant re-promotion of taking→resting orders when called with a slot that's already been seen. */
	maxSlotForRestingLimitOrders = 0;

	/** Set to `true` once `initFromUserMap` has successfully populated this instance; `initFromUserMap` is then a no-op. */
	initialized = false;

	/** Constructs an empty, uninitialized `DLOB` with no orders. Call `initFromUserMap` (or `insertOrder`/`insertSignedMsgOrder`) to populate it. */
	public constructor() {
		this.init();
	}

	private init() {
		this.openOrders.set('perp', new Set<string>());
		this.openOrders.set('spot', new Set<string>());
		this.orderLists.set('perp', new Map<number, MarketNodeLists>());
		this.orderLists.set('spot', new Map<number, MarketNodeLists>());
	}

	private getOpenOrdersForMarketType(
		marketTypeStr: MarketTypeStr
	): Set<string> {
		const openOrders = this.openOrders.get(marketTypeStr);
		if (!openOrders) {
			throw new Error(
				`DLOB has no open orders set for market type ${marketTypeStr}`
			);
		}
		return openOrders;
	}

	private getOrderListsForMarketType(
		marketTypeStr: MarketTypeStr
	): Map<number, MarketNodeLists> {
		const orderLists = this.orderLists.get(marketTypeStr);
		if (!orderLists) {
			throw new Error(
				`DLOB has no order lists for market type ${marketTypeStr}`
			);
		}
		return orderLists;
	}

	private tryGetMarketNodeLists(
		marketTypeStr: MarketTypeStr,
		marketIndex: number
	): MarketNodeLists | undefined {
		return this.orderLists.get(marketTypeStr)?.get(marketIndex);
	}

	private getMarketNodeLists(
		marketTypeStr: MarketTypeStr,
		marketIndex: number
	): MarketNodeLists {
		const marketNodeLists = this.tryGetMarketNodeLists(
			marketTypeStr,
			marketIndex
		);
		if (!marketNodeLists) {
			throw new Error(
				`DLOB has no order lists for market type ${marketTypeStr} and market index ${marketIndex}`
			);
		}
		return marketNodeLists;
	}

	/** Empties every order list and resets the DLOB to its freshly-constructed (uninitialized) state, including `maxSlotForRestingLimitOrders` and `initialized`. */
	public clear() {
		for (const openOrders of this.openOrders.values()) {
			openOrders.clear();
		}
		this.openOrders.clear();

		for (const marketNodeListsMap of this.orderLists.values()) {
			for (const marketNodeLists of marketNodeListsMap.values()) {
				for (const side of Object.values(marketNodeLists)) {
					for (const nodeList of Object.values(side)) {
						nodeList.clear();
					}
				}
			}
		}
		this.orderLists.clear();

		this.maxSlotForRestingLimitOrders = 0;

		this.init();
	}

	/**
	 * Populates this DLOB from every open order across every user in `userMap`. For reduce-only
	 * orders, the fillable amount is capped via `calculateOrderBaseAssetAmount` against the
	 * user's existing perp position for that market, rather than trusting the order's full
	 * stated `baseAssetAmount`. No-ops (returns `false` immediately) if this instance has already
	 * been initialized — call `clear()` first to rebuild from scratch.
	 *
	 * @param userMap map of all users' accounts to index orders from
	 * @param slot slot orders are inserted at, used to classify taking vs. resting limit orders
	 * @returns `true` if this call performed initialization, `false` if it was already initialized
	 */
	public async initFromUserMap(
		userMap: UserMap,
		slot: number
	): Promise<boolean> {
		if (this.initialized) {
			return false;
		}

		// initialize the dlob with the user map
		for (const user of userMap.values()) {
			const userAccount = user.getUserAccountOrThrow();
			const userAccountPubkey = user.getUserAccountPublicKey();
			const userAccountPubkeyString = userAccountPubkey.toString();

			for (const order of userAccount.orders) {
				let baseAssetAmount = order.baseAssetAmount;
				if (order.reduceOnly) {
					const existingBaseAmount =
						userAccount.perpPositions.find(
							(pos) =>
								pos.marketIndex === order.marketIndex && pos.openOrders > 0
						)?.baseAssetAmount || ZERO;
					baseAssetAmount = calculateOrderBaseAssetAmount(
						order,
						existingBaseAmount
					);
				}

				this.insertOrder(order, userAccountPubkeyString, slot, baseAssetAmount);
			}
		}

		this.initialized = true;
		return true;
	}

	/**
	 * Inserts a single on-chain order into the appropriate `NodeList` for its market/side/type.
	 * No-ops if the order's status isn't `open`, or if its `orderType` isn't one of the
	 * DLOB-supported types (`market`, `limit`, `triggerMarket`, `triggerLimit`, `oracle`).
	 * Lazily creates the market's `MarketNodeLists` (via `addOrderList`) on first insert for that
	 * market. Which list the order lands in (taking vs. resting limit, floating, market, or
	 * inactive trigger) is decided by `getListForOnChainOrder`.
	 *
	 * @param order the on-chain order to insert
	 * @param userAccount base58 pubkey string of the order's owner
	 * @param slot current slot, used to classify taking vs. resting limit orders
	 * @param baseAssetAmount remaining fillable base amount, BASE_PRECISION (1e9) — for
	 *   reduce-only orders this should be the position-capped amount (see
	 *   `calculateOrderBaseAssetAmount`), not the raw `order.baseAssetAmount`
	 * @param onInsert optional callback invoked after a successful insert
	 */
	public insertOrder(
		order: Order,
		userAccount: string,
		slot: number,
		baseAssetAmount: BN,
		onInsert?: OrderBookCallback
	): void {
		if (!isVariant(order.status, 'open')) {
			return;
		}

		if (!isOneOfVariant(order.orderType, SUPPORTED_ORDER_TYPES)) {
			return;
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		if (!this.getOrderListsForMarketType(marketType).has(order.marketIndex)) {
			this.addOrderList(marketType, order.marketIndex);
		}

		if (isVariant(order.status, 'open')) {
			this.getOpenOrdersForMarketType(marketType).add(
				getOrderSignature(order.orderId, userAccount)
			);
		}

		this.getListForOnChainOrder(order, slot)?.insert(
			order,
			marketType,
			userAccount,
			baseAssetAmount
		);

		if (onInsert) {
			onInsert();
		}
	}

	/**
	 * Inserts an off-chain signed-message order (not yet landed on-chain) into the market's
	 * `signedMsg` bid/ask list, unconditionally (no status/order-type filtering, unlike
	 * `insertOrder`). Lazily creates the market's `MarketNodeLists` on first insert.
	 *
	 * @param order the signed-message order to insert
	 * @param userAccount base58 pubkey string of the order's owner
	 * @param baseAssetAmount remaining fillable base amount, BASE_PRECISION (1e9); defaults to `order.baseAssetAmount`
	 * @param onInsert optional callback invoked after insert
	 */
	public insertSignedMsgOrder(
		order: Order,
		userAccount: string,
		baseAssetAmount?: BN,
		onInsert?: OrderBookCallback
	): void {
		const marketType = getVariant(order.marketType) as MarketTypeStr;
		const marketIndex = order.marketIndex;
		const bidOrAsk = isVariant(order.direction, 'long') ? 'bid' : 'ask';
		if (!this.getOrderListsForMarketType(marketType).has(order.marketIndex)) {
			this.addOrderList(marketType, order.marketIndex);
		}
		this.getOpenOrdersForMarketType(marketType).add(
			getOrderSignature(order.orderId, userAccount)
		);
		this.getMarketNodeLists(marketType, marketIndex).signedMsg[bidOrAsk].insert(
			order,
			marketType,
			userAccount,
			baseAssetAmount
		);
		if (onInsert) {
			onInsert();
		}
	}

	/** Creates and registers an empty `MarketNodeLists` (all six order categories, both sides) for `marketIndex`, overwriting any existing lists for that market. */
	addOrderList(marketType: MarketTypeStr, marketIndex: number): void {
		this.getOrderListsForMarketType(marketType).set(marketIndex, {
			restingLimit: {
				ask: new NodeList('restingLimit', 'asc'),
				bid: new NodeList('restingLimit', 'desc'),
			},
			floatingLimit: {
				ask: new NodeList('floatingLimit', 'asc'),
				bid: new NodeList('floatingLimit', 'desc'),
			},
			takingLimit: {
				ask: new NodeList('takingLimit', 'asc'),
				bid: new NodeList('takingLimit', 'asc'), // always sort ascending for market orders
			},
			market: {
				ask: new NodeList('market', 'asc'),
				bid: new NodeList('market', 'asc'), // always sort ascending for market orders
			},
			trigger: {
				above: new NodeList('trigger', 'asc'),
				below: new NodeList('trigger', 'desc'),
			},
			signedMsg: {
				ask: new NodeList('signedMsg', 'asc'),
				bid: new NodeList('signedMsg', 'asc'),
			},
		});
	}

	/**
	 * Removes an order from whichever `NodeList` it currently lives in. No-ops if the order's
	 * status isn't `open`. First calls `updateRestingLimitOrders(slot)` so a taking-limit order
	 * that has since become a resting-limit order is looked up (and removed from) the correct
	 * list.
	 *
	 * @param order the order to remove
	 * @param userAccount pubkey of the order's owner
	 * @param slot current slot, used to resolve which list the order is currently in
	 * @param onDelete optional callback invoked after a successful delete
	 */
	public delete(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		onDelete?: OrderBookCallback
	): void {
		if (!isVariant(order.status, 'open')) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		this.getListForOnChainOrder(order, slot)?.remove(
			order,
			userAccount.toString()
		);

		if (onDelete) {
			onDelete();
		}
	}

	/**
	 * Determines which `NodeList` an order belongs in, given its current state and the slot:
	 * a trigger order (`triggerMarket`/`triggerLimit`) that hasn't fired yet goes in
	 * `trigger.above`/`trigger.below`; a market/oracle-type order goes in `market`; a limit order
	 * with a non-zero `oraclePriceOffset` goes in `floatingLimit`; otherwise a limit order goes in
	 * `restingLimit` once its auction is complete or it's post-only (per `isRestingLimitOrder`),
	 * and in `takingLimit` while still auctioning.
	 *
	 * @param order the order to classify
	 * @param slot current slot, used to evaluate `isRestingLimitOrder`
	 * @returns the matching `NodeList`, or `undefined` if the order's market has no `MarketNodeLists` registered yet (e.g. `insertOrder`/`addOrderList` hasn't been called for it)
	 */
	public getListForOnChainOrder(
		order: Order,
		slot: number
	): NodeList<any> | undefined {
		const isInactiveTriggerOrder =
			mustBeTriggered(order) && !isTriggered(order);

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		const marketNodeLists = this.tryGetMarketNodeLists(
			marketType,
			order.marketIndex
		);
		if (!marketNodeLists) {
			return undefined;
		}

		if (isInactiveTriggerOrder) {
			const subType = isVariant(order.triggerCondition, 'above')
				? 'above'
				: 'below';
			return marketNodeLists.trigger[subType];
		}

		const subType = isVariant(order.direction, 'long') ? 'bid' : 'ask';
		if (
			isOneOfVariant(order.orderType, ['market', 'triggerMarket', 'oracle'])
		) {
			return marketNodeLists.market[subType];
		} else if (!order.oraclePriceOffset.eq(ZERO)) {
			return marketNodeLists.floatingLimit[subType];
		} else {
			const isResting = isRestingLimitOrder(order, slot);
			return isResting
				? marketNodeLists.restingLimit[subType]
				: marketNodeLists.takingLimit[subType];
		}
	}

	private getListForOnChainOrderOrThrow(
		order: Order,
		slot: number
	): NodeList<any> {
		const list = this.getListForOnChainOrder(order, slot);
		if (!list) {
			throw new Error(
				`No order list found for order ${order.orderId} in market ${order.marketIndex}`
			);
		}
		return list;
	}

	/**
	 * Promotes any `takingLimit` orders across all perp and spot markets whose auction has since
	 * completed (per `isRestingLimitOrder`) into their market's `restingLimit` list. No-ops if
	 * `slot` is not newer than the last slot this was called with (`maxSlotForRestingLimitOrders`),
	 * so it is cheap to call defensively before any read that depends on resting-limit state
	 * being current (most getters here do so internally).
	 *
	 * @param slot current slot
	 */
	public updateRestingLimitOrders(slot: number): void {
		if (slot <= this.maxSlotForRestingLimitOrders) {
			return;
		}

		this.maxSlotForRestingLimitOrders = slot;

		this.updateRestingLimitOrdersForMarketType(slot, 'perp');

		this.updateRestingLimitOrdersForMarketType(slot, 'spot');
	}

	/** Does the `takingLimit` → `restingLimit` promotion (see `updateRestingLimitOrders`) for every market of one market type. */
	updateRestingLimitOrdersForMarketType(
		slot: number,
		marketTypeStr: MarketTypeStr
	): void {
		for (const [_, nodeLists] of this.getOrderListsForMarketType(
			marketTypeStr
		)) {
			const nodesToUpdate: Array<{ side: 'ask' | 'bid'; node: DLOBNode }> = [];
			for (const node of nodeLists.takingLimit.ask.getGenerator()) {
				if (!isRestingLimitOrder(getOrderOrThrow(node), slot)) {
					continue;
				}

				nodesToUpdate.push({
					side: 'ask',
					node,
				});
			}

			for (const node of nodeLists.takingLimit.bid.getGenerator()) {
				if (!isRestingLimitOrder(getOrderOrThrow(node), slot)) {
					continue;
				}

				nodesToUpdate.push({
					side: 'bid',
					node,
				});
			}

			for (const nodeToUpdate of nodesToUpdate) {
				const { side, node } = nodeToUpdate;
				const order = getOrderOrThrow(node);
				const userAccount = getUserAccountOrThrow(node);
				nodeLists.takingLimit[side].remove(order, userAccount);
				nodeLists.restingLimit[side].insert(order, marketTypeStr, userAccount);
			}
		}
	}

	/**
	 * Looks up an order by id/owner across every `NodeList` in the DLOB (perp and spot, all
	 * categories/sides) via `getNodeLists`. O(number of lists); prefer a narrower lookup (e.g.
	 * `NodeList.get`) if you already know the order's market/type.
	 *
	 * @param orderId the order's id (unique per user account)
	 * @param userAccount pubkey of the order's owner
	 * @returns the matching `Order`, or `undefined` if not found in any list
	 */
	public getOrder(orderId: number, userAccount: PublicKey): Order | undefined {
		const orderSignature = getOrderSignature(orderId, userAccount.toString());
		for (const nodeList of this.getNodeLists()) {
			const node = nodeList.get(orderSignature);
			if (node) {
				return node.order;
			}
		}

		return undefined;
	}

	/**
	 * Top-level entry point for keepers: finds every node in one market that is currently
	 * fillable, combining four sources — crossing resting-limit orders
	 * (`findRestingLimitOrderNodesToFill`), taking (still-auctioning) orders that cross a maker or
	 * fallback price (`findTakingNodesToFill`), expired orders to cancel/settle
	 * (`findExpiredNodesToFill`), and unfillable reduce-only orders below the step size to cancel
	 * (`findUnfillableReduceOnlyOrdersToCancel`). Returns `[]` immediately if fills are paused for
	 * this market (`fillPaused`). The market's `orderTickSize` is read from `marketAccount` and
	 * threaded through to every price comparison below so all crossing checks agree with on-chain
	 * price standardization.
	 *
	 * @param marketIndex the market to scan
	 * @param fallbackBid best available non-DLOB bid (e.g. vAMM), PRICE_PRECISION (1e6); `undefined` disables fallback-bid crossing checks
	 * @param fallbackAsk best available non-DLOB ask (e.g. vAMM), PRICE_PRECISION (1e6); `undefined` disables fallback-ask crossing checks
	 * @param slot current slot
	 * @param ts current unix timestamp (seconds), used to find expired orders
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`; determines whether `oraclePriceData`/`marketAccount` are typed as spot or perp
	 * @param oraclePriceData oracle price data for the market (`MMOraclePriceData` for perp, `OraclePriceData` for spot)
	 * @param stateAccount global protocol state, used for pause checks and fee-tier maker rebates
	 * @param marketAccount the market's account, used for `orderTickSize`/`orderStepSize` and pause checks
	 * @returns deduplicated `NodeToFill`s (see `mergeNodesToFill`) merging resting-limit and taking-order matches, plus expired and cancel-eligible nodes appended
	 */
	public findNodesToFill<T extends MarketType>(
		marketIndex: number,
		fallbackBid: BN | undefined,
		fallbackAsk: BN | undefined,
		slot: number,
		ts: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		stateAccount: StateAccount,
		marketAccount: T extends { spot: unknown }
			? SpotMarketAccount
			: PerpMarketAccount
	): NodeToFill[] {
		if (fillPaused(stateAccount, marketAccount)) {
			return [];
		}

		const isAmmPaused = ammPaused(stateAccount, marketAccount);

		const tickSize = (marketAccount as PerpMarketAccount | SpotMarketAccount)
			.orderTickSize;

		const { makerRebateNumerator, makerRebateDenominator } =
			this.getMakerRebate(marketType, stateAccount, marketAccount);

		const takingOrderNodesToFill: Array<NodeToFill> =
			this.findTakingNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				stateAccount,
				marketAccount,
				fallbackAsk,
				fallbackBid,
				tickSize
			);

		const restingLimitOrderNodesToFill: Array<NodeToFill> =
			this.findRestingLimitOrderNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				stateAccount,
				marketAccount,
				makerRebateNumerator,
				makerRebateDenominator,
				fallbackAsk,
				fallbackBid,
				tickSize
			);

		// get expired market nodes
		const expiredNodesToFill = this.findExpiredNodesToFill(
			marketIndex,
			ts,
			marketType,
			new BN(slot)
		);

		const stepSize = isVariant(marketType, 'perp')
			? (marketAccount as PerpMarketAccount).orderStepSize
			: (marketAccount as SpotMarketAccount).orderStepSize;

		const cancelReduceOnlyNodesToFill =
			this.findUnfillableReduceOnlyOrdersToCancel(
				marketIndex,
				marketType,
				stepSize
			);

		return this.mergeNodesToFill(
			restingLimitOrderNodesToFill,
			takingOrderNodesToFill
		)
			.concat(expiredNodesToFill)
			.concat(cancelReduceOnlyNodesToFill);
	}

	/**
	 * Reads the tier-0 maker rebate fraction (`makerRebateNumerator / makerRebateDenominator`)
	 * for a market from `stateAccount`'s perp/spot fee structure, then scales the numerator up by
	 * the market's `feeAdjustment` percentage if one is set. Used by `findRestingLimitOrderNodesToFill`
	 * to size the buffer added to fallback prices so fallback fills aren't triggered by rebate-sized
	 * noise.
	 *
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param stateAccount global protocol state holding the perp/spot fee tier tables
	 * @param marketAccount the specific market, whose optional `feeAdjustment` (percent) scales the rebate
	 * @returns the rebate as a numerator/denominator pair (unitless fraction, not a fixed-point BN)
	 */
	getMakerRebate(
		marketType: MarketType,
		stateAccount: StateAccount,
		marketAccount: PerpMarketAccount | SpotMarketAccount
	): { makerRebateNumerator: number; makerRebateDenominator: number } {
		let makerRebateNumerator: number;
		let makerRebateDenominator: number;
		if (isVariant(marketType, 'perp')) {
			makerRebateNumerator =
				stateAccount.perpFeeStructure.feeTiers[0].makerRebateNumerator;
			makerRebateDenominator =
				stateAccount.perpFeeStructure.feeTiers[0].makerRebateDenominator;
		} else {
			makerRebateNumerator =
				stateAccount.spotFeeStructure.feeTiers[0].makerRebateNumerator;
			makerRebateDenominator =
				stateAccount.spotFeeStructure.feeTiers[0].makerRebateDenominator;
		}

		// @ts-ignore
		const feeAdjustment = marketAccount.feeAdjustment || 0;
		if (feeAdjustment !== 0) {
			makerRebateNumerator += (makerRebateNumerator * feeAdjustment) / 100;
		}

		return { makerRebateNumerator, makerRebateDenominator };
	}

	/**
	 * Merges two `NodeToFill` arrays (typically resting-limit crossings and taking-order
	 * crossings for the same market/pass) by taker order signature, concatenating `makerNodes`
	 * for any taker that appears in both — e.g. an order that both crosses a resting maker and
	 * separately crosses fallback liquidity ends up as one `NodeToFill` with both maker sources.
	 *
	 * @param restingLimitOrderNodesToFill fills found via resting-limit crossing
	 * @param takingOrderNodesToFill fills found via taking-order crossing
	 * @returns one `NodeToFill` per distinct taker order, with all matched maker nodes combined
	 */
	mergeNodesToFill(
		restingLimitOrderNodesToFill: NodeToFill[],
		takingOrderNodesToFill: NodeToFill[]
	): NodeToFill[] {
		const mergedNodesToFill = new Map<string, NodeToFill>();

		const mergeNodesToFillHelper = (nodesToFillArray: NodeToFill[]) => {
			nodesToFillArray.forEach((nodeToFill) => {
				const nodeSignature = getOrderSignature(
					getOrderOrThrow(nodeToFill.node).orderId,
					getUserAccountOrThrow(nodeToFill.node)
				);

				let mergedNodeToFill = mergedNodesToFill.get(nodeSignature);
				if (!mergedNodeToFill) {
					mergedNodeToFill = {
						node: nodeToFill.node,
						makerNodes: [],
					};
					mergedNodesToFill.set(nodeSignature, mergedNodeToFill);
				}

				if (nodeToFill.makerNodes) {
					mergedNodeToFill.makerNodes.push(...nodeToFill.makerNodes);
				}
			});
		};

		mergeNodesToFillHelper(restingLimitOrderNodesToFill);
		mergeNodesToFillHelper(takingOrderNodesToFill);

		return Array.from(mergedNodesToFill.values());
	}

	/**
	 * Finds resting-limit-order fills for a market: resting bids/asks that cross each other
	 * (`findCrossingRestingLimitOrders`), plus resting asks that cross the fallback bid and
	 * resting bids that cross the fallback ask (each skipped entirely if the AMM is paused).
	 * The fallback price on each side is tightened by the maker rebate before comparing, so a
	 * maker order priced exactly at the rebate-adjusted fallback isn't spuriously flagged as
	 * crossing (`fallbackBidWithBuffer = fallbackBid - fallbackBid * makerRebateNumerator / makerRebateDenominator`,
	 * and symmetrically for the ask).
	 *
	 * @param marketIndex the market to scan
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market
	 * @param isAmmPaused if true, skips fallback-crossing checks (only maker-vs-maker crossings are returned)
	 * @param stateAccount global protocol state, forwarded to fallback-availability checks
	 * @param marketAccount the market's account, forwarded to fallback-availability checks
	 * @param makerRebateNumerator numerator of the maker rebate fraction (see `getMakerRebate`)
	 * @param makerRebateDenominator denominator of the maker rebate fraction (see `getMakerRebate`)
	 * @param fallbackAsk best available non-DLOB ask, PRICE_PRECISION (1e6); `undefined` skips fallback-ask crossing
	 * @param fallbackBid best available non-DLOB bid, PRICE_PRECISION (1e6); `undefined` skips fallback-bid crossing
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6), threaded into every price comparison; omit to fall back to no rounding
	 * @returns `NodeToFill`s for maker-crossing-maker and maker-crossing-fallback matches
	 */
	public findRestingLimitOrderNodesToFill<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		isAmmPaused: boolean,
		stateAccount: StateAccount,
		marketAccount: T extends { spot: unknown }
			? SpotMarketAccount
			: PerpMarketAccount,
		makerRebateNumerator: number,
		makerRebateDenominator: number,
		fallbackAsk: BN | undefined,
		fallbackBid: BN | undefined,
		tickSize?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const crossingNodes = this.findCrossingRestingLimitOrders(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			tickSize
		);

		for (const crossingNode of crossingNodes) {
			nodesToFill.push(crossingNode);
		}

		if (fallbackBid && !isAmmPaused) {
			const askGenerator = this.getRestingLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			);

			const fallbackBidWithBuffer = fallbackBid.sub(
				fallbackBid.muln(makerRebateNumerator).divn(makerRebateDenominator)
			);

			const asksCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				askGenerator,
				(askPrice) => {
					if (askPrice === undefined) {
						throw new Error('Resting limit ask must have a limit price');
					}
					return askPrice.lte(fallbackBidWithBuffer);
				},
				stateAccount,
				marketAccount,
				tickSize
			);

			for (const askCrossingFallback of asksCrossingFallback) {
				nodesToFill.push(askCrossingFallback);
			}
		}

		if (fallbackAsk && !isAmmPaused) {
			const bidGenerator = this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			);

			const fallbackAskWithBuffer = fallbackAsk.add(
				fallbackAsk.muln(makerRebateNumerator).divn(makerRebateDenominator)
			);

			const bidsCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				bidGenerator,
				(bidPrice) => {
					if (bidPrice === undefined) {
						throw new Error('Resting limit bid must have a limit price');
					}
					return bidPrice.gte(fallbackAskWithBuffer);
				},
				stateAccount,
				marketAccount,
				tickSize
			);

			for (const bidCrossingFallback of bidsCrossingFallback) {
				nodesToFill.push(bidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	/**
	 * Finds fills for taking (still-auctioning) orders: taking asks crossing resting bids or the
	 * fallback bid, and taking bids crossing resting asks or the fallback ask
	 * (`findTakingNodesCrossingMakerNodes` / `findNodesCrossingFallbackLiquidity`). Fallback
	 * crossing checks are skipped entirely when `isAmmPaused`. For spot markets, a taking order is
	 * only allowed to cross the opposite fallback price if doing so wouldn't also require crossing
	 * beyond the *other* fallback price (see the inline `fallbackBid`/`fallbackAsk` guards) —
	 * this prevents a taking order from routing through DLOB makers priced worse than the AMM.
	 *
	 * @param marketIndex the market to scan
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market
	 * @param isAmmPaused if true, skips fallback-crossing checks
	 * @param state global protocol state, forwarded to fallback-availability checks
	 * @param marketAccount the market's account, forwarded to fallback-availability checks
	 * @param fallbackAsk best available non-DLOB ask, PRICE_PRECISION (1e6); `undefined` skips ask-side fallback crossing
	 * @param fallbackBid best available non-DLOB bid, PRICE_PRECISION (1e6); `undefined` skips bid-side fallback crossing
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6), threaded into every price comparison; omit to fall back to no rounding
	 * @returns `NodeToFill`s for taking orders that cross a resting maker or fallback liquidity
	 */
	public findTakingNodesToFill<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		isAmmPaused: boolean,
		state: StateAccount,
		marketAccount: T extends { spot: unknown }
			? SpotMarketAccount
			: PerpMarketAccount,
		fallbackAsk: BN | undefined,
		fallbackBid?: BN | undefined,
		tickSize?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let takingOrderGenerator = this.getTakingAsks(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		);

		const takingAsksCrossingBids = this.findTakingNodesCrossingMakerNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			takingOrderGenerator,
			this.getRestingLimitBids.bind(this),
			(takerPrice, makerPrice) => {
				if (isVariant(marketType, 'spot')) {
					if (takerPrice === undefined) {
						return false;
					}

					if (fallbackBid && makerPrice.lt(fallbackBid)) {
						return false;
					}
				}
				return takerPrice === undefined || takerPrice.lte(makerPrice);
			},
			tickSize
		);
		for (const takingAskCrossingBid of takingAsksCrossingBids) {
			nodesToFill.push(takingAskCrossingBid);
		}

		if (fallbackBid && !isAmmPaused) {
			takingOrderGenerator = this.getTakingAsks(
				marketIndex,
				marketType,
				slot,
				oraclePriceData
			);
			const takingAsksCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					takingOrderGenerator,
					(takerPrice) => {
						return takerPrice === undefined || takerPrice.lte(fallbackBid);
					},
					state,
					marketAccount,
					tickSize
				);

			for (const takingAskCrossingFallback of takingAsksCrossingFallback) {
				nodesToFill.push(takingAskCrossingFallback);
			}
		}

		takingOrderGenerator = this.getTakingBids(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		);

		const takingBidsToFill = this.findTakingNodesCrossingMakerNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			takingOrderGenerator,
			this.getRestingLimitAsks.bind(this),
			(takerPrice, makerPrice) => {
				if (isVariant(marketType, 'spot')) {
					if (takerPrice === undefined) {
						return false;
					}

					if (fallbackAsk && makerPrice.gt(fallbackAsk)) {
						return false;
					}
				}

				return takerPrice === undefined || takerPrice.gte(makerPrice);
			},
			tickSize
		);

		for (const takingBidToFill of takingBidsToFill) {
			nodesToFill.push(takingBidToFill);
		}

		if (fallbackAsk && !isAmmPaused) {
			takingOrderGenerator = this.getTakingBids(
				marketIndex,
				marketType,
				slot,
				oraclePriceData
			);
			const takingBidsCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					takingOrderGenerator,
					(takerPrice) => {
						return takerPrice === undefined || takerPrice.gte(fallbackAsk);
					},
					state,
					marketAccount,
					tickSize
				);
			for (const marketBidCrossingFallback of takingBidsCrossingFallback) {
				nodesToFill.push(marketBidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	/**
	 * Walks `takerNodeGenerator` (taking bids or asks, sorted by arrival slot) against a fresh
	 * maker-side generator (built per taker via `makerNodeGeneratorFn`, e.g.
	 * `getRestingLimitBids`) and records a `NodeToFill` for every taker/maker pair that
	 * `doesCross` accepts, skipping same-user matches. For each match this method also **mutates
	 * DLOB state**: it applies the simulated fill to both the maker's and taker's order lists
	 * (via `NodeList.update`) so subsequent iterations see updated `baseAssetAmountFilled` and a
	 * taker stops matching once fully filled. Because maker nodes (sorted by price) are scanned
	 * in order, `doesCross` returning false breaks out of the maker loop entirely — this is
	 * correct for resting-limit makers but relies on the maker generator being price-sorted, not
	 * time-sorted.
	 *
	 * @param marketIndex the market being scanned (used only to route signed-message taker fills into the right list)
	 * @param slot current slot, forwarded to price lookups
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market
	 * @param takerNodeGenerator taking orders to check, e.g. from `getTakingAsks`/`getTakingBids`
	 * @param makerNodeGeneratorFn factory invoked once per taker to get a fresh maker-side generator, e.g. `getRestingLimitBids`/`getRestingLimitAsks`
	 * @param doesCross given the taker's price (`undefined` if it has none, e.g. still mid-auction) and the maker's price, returns whether they cross
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6), threaded into all price lookups
	 * @returns one `NodeToFill` per matched taker/maker pair (a taker matched against multiple makers yields multiple entries, each with one maker)
	 */
	public findTakingNodesCrossingMakerNodes<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		takerNodeGenerator: Generator<DLOBNode>,
		makerNodeGeneratorFn: (
			marketIndex: number,
			slot: number,
			marketType: T,
			oraclePriceData: T extends { spot: unknown }
				? OraclePriceData
				: MMOraclePriceData,
			filterFcn?: DLOBFilterFcn,
			tickSize?: BN
		) => Generator<DLOBNode>,
		doesCross: (takerPrice: BN | undefined, makerPrice: BN) => boolean,
		tickSize?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const takerNode of takerNodeGenerator) {
			const makerNodeGenerator = makerNodeGeneratorFn(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			);

			for (const makerNode of makerNodeGenerator) {
				// Can't match orders from the same user
				const sameUser = takerNode.userAccount === makerNode.userAccount;
				if (sameUser) {
					continue;
				}

				const makerPrice = makerNode.getPriceOrThrow(
					oraclePriceData,
					slot,
					tickSize
				);
				const takerPrice = takerNode.getPrice(oraclePriceData, slot, tickSize);

				const ordersCross = doesCross(takerPrice, makerPrice);
				if (!ordersCross) {
					// market orders aren't sorted by price, they are sorted by time, so we need to traverse
					// through all of em
					break;
				}

				nodesToFill.push({
					node: takerNode,
					makerNodes: [makerNode],
				});

				const makerOrder = getOrderOrThrow(makerNode);
				const takerOrder = getOrderOrThrow(takerNode);

				const makerBaseRemaining = makerOrder.baseAssetAmount.sub(
					makerOrder.baseAssetAmountFilled
				);
				const takerBaseRemaining = takerOrder.baseAssetAmount.sub(
					takerOrder.baseAssetAmountFilled
				);

				const baseFilled = BN.min(makerBaseRemaining, takerBaseRemaining);

				const newMakerOrder = { ...makerOrder };
				newMakerOrder.baseAssetAmountFilled =
					makerOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOnChainOrderOrThrow(newMakerOrder, slot).update(
					newMakerOrder,
					getUserAccountOrThrow(makerNode)
				);

				const newTakerOrder = { ...takerOrder };
				newTakerOrder.baseAssetAmountFilled =
					takerOrder.baseAssetAmountFilled.add(baseFilled);

				if (takerNode.isSignedMsg) {
					const marketTypeStr = getVariant(marketType) as MarketTypeStr;
					const marketNodeLists = this.getMarketNodeLists(
						marketTypeStr,
						marketIndex
					);
					const orderList = isVariant(takerOrder.direction, 'long')
						? marketNodeLists.signedMsg.bid
						: marketNodeLists.signedMsg.ask;
					orderList.update(newTakerOrder, getUserAccountOrThrow(takerNode));
				} else {
					this.getListForOnChainOrderOrThrow(newTakerOrder, slot).update(
						newTakerOrder,
						getUserAccountOrThrow(takerNode)
					);
				}

				if (
					newTakerOrder.baseAssetAmountFilled.eq(takerOrder.baseAssetAmount)
				) {
					break;
				}
			}
		}

		return nodesToFill;
	}

	/**
	 * Scans `nodeGenerator` for nodes that both cross the fallback price (`doesCross`, evaluated
	 * against each node's `getLimitPrice`, or crossing unconditionally if the node has no limit
	 * price) and have fallback liquidity actually available to fill against. For spot markets,
	 * post-only orders are skipped (they can never take against the AMM) and fallback liquidity
	 * is always considered available; for perp markets, availability additionally requires
	 * `isFallbackAvailableLiquiditySource` (broadly: the order's auction is complete and the
	 * oracle is valid enough for AMM fills). Does not mutate any order state — unlike
	 * `findTakingNodesCrossingMakerNodes`, fallback fills are expected to be sized/settled
	 * on-chain rather than simulated here.
	 *
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param slot current slot
	 * @param oraclePriceData oracle price data for the market
	 * @param nodeGenerator candidate nodes to check, e.g. resting-limit or taking orders
	 * @param doesCross given a node's limit price (`undefined` if it has none), returns whether it crosses the fallback price
	 * @param state global protocol state, used by the perp fallback-availability check
	 * @param marketAccount the market's account, used by the perp fallback-availability check
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6), used to resolve each node's limit price
	 * @returns `NodeToFill`s with an empty `makerNodes` array (the fill is expected to route through fallback liquidity, not a DLOB maker)
	 */
	public findNodesCrossingFallbackLiquidity<T extends MarketType>(
		marketType: T,
		slot: number,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		nodeGenerator: Generator<DLOBNode>,
		doesCross: (nodePrice: BN | undefined) => boolean,
		state: StateAccount,
		marketAccount: T extends { spot: unknown }
			? SpotMarketAccount
			: PerpMarketAccount,
		tickSize?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let nextNode = nodeGenerator.next();
		while (!nextNode.done) {
			const node = nextNode.value;

			if (isVariant(marketType, 'spot') && node.order?.postOnly) {
				nextNode = nodeGenerator.next();
				continue;
			}
			const nodeOrder = getOrderOrThrow(node);
			const nodePrice = getLimitPrice(
				nodeOrder,
				oraclePriceData,
				slot,
				undefined,
				tickSize
			);

			// order crosses if there is no limit price or it crosses fallback price
			const crosses = doesCross(nodePrice);

			// fallback is available if auction is complete or it's a spot order
			const fallbackAvailable =
				isVariant(marketType, 'spot') ||
				isFallbackAvailableLiquiditySource(
					nodeOrder,
					oraclePriceData as MMOraclePriceData,
					slot,
					state,
					marketAccount as PerpMarketAccount
				);

			if (crosses && fallbackAvailable) {
				nodesToFill.push({
					node: node,
					makerNodes: [], // filled by fallback
				});
			}

			nextNode = nodeGenerator.next();
		}

		return nodesToFill;
	}

	/**
	 * Finds orders in a market that are eligible to be expired: any non-trigger, non-TIF-limit
	 * order whose `maxTs` (plus a 25-second buffer for limit orders, via `isOrderExpired`) has
	 * passed the given timestamp. Also proactively removes (not just reports) signed-message
	 * orders whose auction window (`order.slot + order.auctionDuration`) has passed `slot`, since
	 * those never landed on-chain and have no on-chain expiration to wait for.
	 *
	 * @param marketIndex the market to scan
	 * @param ts current unix timestamp (seconds)
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param slot current slot; required if the market has any signed-message orders (throws otherwise)
	 * @returns `NodeToFill`s (with empty `makerNodes`) for orders ready to expire
	 * @throws if a signed-message order is present and `slot` was not provided
	 */
	public findExpiredNodesToFill(
		marketIndex: number,
		ts: number,
		marketType: MarketType,
		slot?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.tryGetMarketNodeLists(marketTypeStr, marketIndex);

		if (!nodeLists) {
			return nodesToFill;
		}

		// All bids/asks that can expire
		// dont try to expire limit orders with tif as its inefficient use of blockspace
		const bidGenerators = [
			nodeLists.takingLimit.bid.getGenerator(),
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
			nodeLists.signedMsg.bid.getGenerator(),
		];
		const askGenerators = [
			nodeLists.takingLimit.ask.getGenerator(),
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
			nodeLists.signedMsg.ask.getGenerator(),
		];

		for (const bidGenerator of bidGenerators) {
			for (const bid of bidGenerator) {
				const bidOrder = getOrderOrThrow(bid);
				if (bid.isSignedMsg) {
					if (slot === undefined) {
						throw new Error(
							'Must provide slot to findExpiredNodesToFill to expire signedMsg orders'
						);
					}
					if (slot.gt(bidOrder.slot.addn(bidOrder.auctionDuration))) {
						nodeLists.signedMsg.bid.remove(
							bidOrder,
							getUserAccountOrThrow(bid)
						);
						continue;
					}
				}
				if (isOrderExpired(bidOrder, ts, true, 25)) {
					nodesToFill.push({
						node: bid,
						makerNodes: [],
					});
				}
			}
		}

		for (const askGenerator of askGenerators) {
			for (const ask of askGenerator) {
				const askOrder = getOrderOrThrow(ask);
				if (ask.isSignedMsg) {
					if (slot === undefined) {
						throw new Error(
							'Must provide slot to findExpiredNodesToFill to expire signedMsg orders'
						);
					}
					if (slot.gt(askOrder.slot.addn(askOrder.auctionDuration))) {
						nodeLists.signedMsg.ask.remove(
							askOrder,
							getUserAccountOrThrow(ask)
						);
						continue;
					}
				}
				if (isOrderExpired(askOrder, ts, true, 25)) {
					nodesToFill.push({
						node: ask,
						makerNodes: [],
					});
				}
			}
		}

		return nodesToFill;
	}

	/**
	 * Finds reduce-only orders across every category/side in a market whose remaining
	 * `baseAssetAmount` (as tracked on the node, not necessarily the order's original size) has
	 * dropped below the market's minimum step size — meaning the order can never be filled again
	 * and should be canceled by a keeper rather than left to linger.
	 *
	 * @param marketIndex the market to scan
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param stepSize market's minimum order step size, BASE_PRECISION (1e9)
	 * @returns `NodeToFill`s (with empty `makerNodes`) for reduce-only orders that should be canceled
	 */
	public findUnfillableReduceOnlyOrdersToCancel(
		marketIndex: number,
		marketType: MarketType,
		stepSize: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.tryGetMarketNodeLists(marketTypeStr, marketIndex);

		if (!nodeLists) {
			return nodesToFill;
		}

		const generators = [
			nodeLists.takingLimit.bid.getGenerator(),
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
			nodeLists.signedMsg.bid.getGenerator(),
			nodeLists.takingLimit.ask.getGenerator(),
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
			nodeLists.signedMsg.ask.getGenerator(),
			nodeLists.trigger.above.getGenerator(),
			nodeLists.trigger.below.getGenerator(),
		];

		for (const generator of generators) {
			for (const node of generator) {
				if (!getOrderOrThrow(node).reduceOnly) {
					continue;
				}

				if (node.baseAssetAmount.lt(stepSize)) {
					nodesToFill.push({
						node,
						makerNodes: [],
					});
				}
			}
		}

		return nodesToFill;
	}
	/**
	 * Yields taking (still-auctioning) bid nodes for a market — market-bid orders, taking-limit
	 * bids, and signed-message bids not yet resting — merged in arrival order (earliest `slot`
	 * first, via `getBestNode`). Calls `updateRestingLimitOrders(slot)` first so a signed-message
	 * order that has since become a resting-limit order is excluded here.
	 *
	 * @param marketIndex the market to scan
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param slot current slot
	 * @param oraclePriceData oracle price data for the market (unused for the ordering itself, forwarded to `getBestNode`)
	 * @param filterFcn optional predicate; nodes it rejects are skipped and not yielded
	 * @returns a generator of taking bid nodes, or an empty generator if the market has no `MarketNodeLists`
	 */
	*getTakingBids<T extends MarketType>(
		marketIndex: number,
		marketType: T,
		slot: number,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.tryGetMarketNodeLists(marketTypeStr, marketIndex);
		if (!orderLists) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		const generatorList = [
			orderLists.market.bid.getGenerator(),
			orderLists.takingLimit.bid.getGenerator(),
			this.signedMsgGenerator(
				orderLists.signedMsg.bid,
				(x: DLOBNode) => !isRestingLimitOrder(getOrderOrThrow(x), slot)
			),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode) => {
				return getOrderOrThrow(bestNode).slot.lt(
					getOrderOrThrow(currentNode).slot
				);
			},
			filterFcn
		);
	}

	/** Same as `getTakingBids`, but for the ask side. */
	*getTakingAsks<T extends MarketType>(
		marketIndex: number,
		marketType: T,
		slot: number,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.tryGetMarketNodeLists(marketTypeStr, marketIndex);
		if (!orderLists) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		const generatorList = [
			orderLists.market.ask.getGenerator(),
			orderLists.takingLimit.ask.getGenerator(),
			this.signedMsgGenerator(
				orderLists.signedMsg.ask,
				(x: DLOBNode) => !isRestingLimitOrder(getOrderOrThrow(x), slot)
			),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode) => {
				return getOrderOrThrow(bestNode).slot.lt(
					getOrderOrThrow(currentNode).slot
				);
			},
			filterFcn
		);
	}

	/** Filters a `signedMsg` `NodeList`'s nodes by an arbitrary predicate — used to split signed-message orders into "still taking" vs. "now resting" subsets based on `isRestingLimitOrder`. */
	protected *signedMsgGenerator(
		signedMsgOrderList: NodeList<'signedMsg'>,
		filter: (x: DLOBNode) => boolean
	): Generator<DLOBNode> {
		for (const signedMsgOrder of signedMsgOrderList.getGenerator()) {
			if (filter(signedMsgOrder)) {
				yield signedMsgOrder;
			}
		}
	}

	/**
	 * K-way-merges multiple node generators (e.g. one per order category feeding one side of the
	 * book) into a single generator ordered by `compareFcn`, skipping nodes that are already
	 * fully filled (`isBaseFilled`) or rejected by `filterFcn`. This is the shared core behind
	 * `getTakingBids`/`getTakingAsks`/`getRestingLimitBids`/`getRestingLimitAsks`/`getBids`/`getAsks`
	 * — each just supplies a different `generatorList` and `compareFcn`.
	 *
	 * @param generatorList the node generators to merge; each must already be sorted per `compareFcn`
	 * @param oraclePriceData oracle price data, forwarded to `compareFcn`
	 * @param slot current slot, forwarded to `compareFcn`
	 * @param compareFcn returns true if `bestDLOBNode` should be preferred over `currentDLOBNode`
	 * @param filterFcn optional predicate; nodes it rejects are advanced past and not yielded
	 * @returns a single generator yielding the merged, filtered, non-fully-filled nodes in `compareFcn` order
	 */
	protected *getBestNode<T extends MarketTypeStr>(
		generatorList: Array<Generator<DLOBNode>>,
		oraclePriceData: T extends 'spot' ? OraclePriceData : MMOraclePriceData,
		slot: number,
		compareFcn: (
			bestDLOBNode: DLOBNode,
			currentDLOBNode: DLOBNode,
			slot: number,
			oraclePriceData: T extends 'spot' ? OraclePriceData : MMOraclePriceData
		) => boolean,
		filterFcn?: DLOBFilterFcn
	): Generator<DLOBNode> {
		const generators = generatorList.map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let sideExhausted = false;
		while (!sideExhausted) {
			const bestGenerator = generators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestValue = bestGenerator.next.value as DLOBNode;
					const currentValue = currentGenerator.next.value as DLOBNode;

					return compareFcn(bestValue, currentValue, slot, oraclePriceData)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				// skip this node if it's already completely filled
				if (bestGenerator.next.value.isBaseFilled()) {
					bestGenerator.next = bestGenerator.generator.next();
					continue;
				}

				if (filterFcn && !filterFcn(bestGenerator.next.value)) {
					bestGenerator.next = bestGenerator.generator.next();
					continue;
				}

				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				sideExhausted = true;
			}
		}
	}

	/**
	 * Yields resting-limit ask nodes for a market — `restingLimit`, `floatingLimit`, and any
	 * `signedMsg` asks that have become resting — merged best-price-first (lowest ask price
	 * first, ties broken by `getBestNode`'s underlying comparator). Calls
	 * `updateRestingLimitOrders(slot)` first. `tickSize` is threaded into every price comparison
	 * via `DLOBNode.getPriceOrThrow`, so pass the market's `orderTickSize` to match on-chain
	 * price standardization — omitting it defaults to no rounding (tick of 1).
	 *
	 * @param marketIndex the market to scan
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market; required for spot markets (throws if missing)
	 * @param filterFcn optional predicate; nodes it rejects are skipped
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns a generator of resting-limit ask nodes, best price first
	 * @throws if `marketType` is spot and `oraclePriceData` is not provided; also throws (via `getPriceOrThrow`) if any node has no resolvable limit price
	 */
	*getRestingLimitAsks<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		filterFcn?: DLOBFilterFcn,
		tickSize?: BN
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		this.updateRestingLimitOrders(slot);

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.tryGetMarketNodeLists(marketTypeStr, marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			this.signedMsgGenerator(nodeLists.signedMsg.ask, (x: DLOBNode) =>
				isRestingLimitOrder(getOrderOrThrow(x), slot)
			),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				return bestNode
					.getPriceOrThrow(oraclePriceData, slot, tickSize)
					.lt(currentNode.getPriceOrThrow(oraclePriceData, slot, tickSize));
			},
			filterFcn
		);
	}

	/** Same as `getRestingLimitAsks`, but for the bid side (merged best-price-first, highest bid first). */
	*getRestingLimitBids<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		filterFcn?: DLOBFilterFcn,
		tickSize?: BN
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		this.updateRestingLimitOrders(slot);

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.tryGetMarketNodeLists(marketTypeStr, marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			this.signedMsgGenerator(nodeLists.signedMsg.bid, (x: DLOBNode) =>
				isRestingLimitOrder(getOrderOrThrow(x), slot)
			),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				return bestNode
					.getPriceOrThrow(oraclePriceData, slot, tickSize)
					.gt(currentNode.getPriceOrThrow(oraclePriceData, slot, tickSize));
			},
			filterFcn
		);
	}

	/**
	 * Merges `getTakingAsks` and `getRestingLimitAsks` into a single best-price-first generator
	 * (ties broken by earliest arrival slot). Nodes with no resolvable price (e.g. still
	 * mid-auction) sort as price `0` — i.e. best — since `getPrice` (not `getPriceOrThrow`) is
	 * used here. Unlike `findTakingNodesToFill`/`findNodesToFill`, this does **not** merge in
	 * fallback (e.g. vAMM) liquidity; the `fallbackAsk` parameter is currently unused/reserved.
	 *
	 * @param marketIndex the market to scan
	 * @param fallbackAsk currently unused
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market; required for spot markets (throws if missing)
	 * @param filterFcn optional predicate; nodes it rejects are skipped
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns a generator of all ask nodes (taking + resting-limit), best price first
	 */
	*getAsks<T extends MarketType>(
		marketIndex: number,
		_fallbackAsk: BN | undefined,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		filterFcn?: DLOBFilterFcn,
		tickSize?: BN
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		const generatorList = [
			this.getTakingAsks(marketIndex, marketType, slot, oraclePriceData),
			this.getRestingLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				const bestNodePrice =
					bestNode.getPrice(oraclePriceData, slot, tickSize) ?? ZERO;
				const currentNodePrice =
					currentNode.getPrice(oraclePriceData, slot, tickSize) ?? ZERO;

				if (bestNodePrice.eq(currentNodePrice)) {
					return getOrderOrThrow(bestNode).slot.lt(
						getOrderOrThrow(currentNode).slot
					);
				}

				return bestNodePrice.lt(currentNodePrice);
			},
			filterFcn
		);
	}

	/**
	 * Merges `getTakingBids` and `getRestingLimitBids` into a single best-price-first generator
	 * (ties broken by earliest arrival slot). Nodes with no resolvable price sort as `BN_MAX` —
	 * i.e. worst — since a priceless bid shouldn't be preferred over a priced one. Does not merge
	 * in fallback (e.g. vAMM) liquidity; the `fallbackBid` parameter is currently unused/reserved.
	 *
	 * @param marketIndex the market to scan
	 * @param fallbackBid currently unused
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market; required for spot markets (throws if missing)
	 * @param filterFcn optional predicate; nodes it rejects are skipped
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns a generator of all bid nodes (taking + resting-limit), best price first
	 */
	*getBids<T extends MarketType>(
		marketIndex: number,
		_fallbackBid: BN | undefined,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		filterFcn?: DLOBFilterFcn,
		tickSize?: BN
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		const generatorList = [
			this.getTakingBids(marketIndex, marketType, slot, oraclePriceData),
			this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				const bestNodePrice =
					bestNode.getPrice(oraclePriceData, slot, tickSize) ?? BN_MAX;
				const currentNodePrice =
					currentNode.getPrice(oraclePriceData, slot, tickSize) ?? BN_MAX;

				if (bestNodePrice.eq(currentNodePrice)) {
					return getOrderOrThrow(bestNode).slot.lt(
						getOrderOrThrow(currentNode).slot
					);
				}

				return bestNodePrice.gt(currentNodePrice);
			},
			filterFcn
		);
	}

	/**
	 * Finds pairs of resting-limit asks and bids that cross each other (`bidPrice >= askPrice`),
	 * assigns maker/taker roles via `determineMakerAndTaker` (post-only orders are always makers;
	 * otherwise whichever order's auction finished later is the taker), and simulates the fill by
	 * updating both orders' `baseAssetAmountFilled` in their `NodeList`s so subsequent iterations
	 * see the reduced remaining size. Same-user matches are skipped. Because both ask and bid
	 * generators are price-sorted, the inner loop `break`s as soon as `bidPrice < askPrice` for a
	 * given ask, since no later (worse) bid can cross either.
	 *
	 * @param marketIndex the market to scan
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6), threaded into all price lookups
	 * @returns `NodeToFill`s (taker node + one maker node each) for every crossing pair found
	 */
	findCrossingRestingLimitOrders<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		tickSize?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const askNode of this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			undefined,
			tickSize
		)) {
			const bidGenerator = this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			);

			for (const bidNode of bidGenerator) {
				const bidPrice = bidNode.getPriceOrThrow(
					oraclePriceData,
					slot,
					tickSize
				);
				const askPrice = askNode.getPriceOrThrow(
					oraclePriceData,
					slot,
					tickSize
				);

				// orders don't cross
				if (bidPrice.lt(askPrice)) {
					break;
				}

				const bidOrder = getOrderOrThrow(bidNode);
				const askOrder = getOrderOrThrow(askNode);

				// Can't match orders from the same user
				const sameUser = bidNode.userAccount === askNode.userAccount;
				if (sameUser) {
					continue;
				}

				const makerAndTaker = this.determineMakerAndTaker(askNode, bidNode);

				// unable to match maker and taker due to post only or slot
				if (!makerAndTaker) {
					continue;
				}

				const { takerNode, makerNode } = makerAndTaker;

				const bidBaseRemaining = bidOrder.baseAssetAmount.sub(
					bidOrder.baseAssetAmountFilled
				);
				const askBaseRemaining = askOrder.baseAssetAmount.sub(
					askOrder.baseAssetAmountFilled
				);

				const baseFilled = BN.min(bidBaseRemaining, askBaseRemaining);

				const newBidOrder = { ...bidOrder };
				newBidOrder.baseAssetAmountFilled =
					bidOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOnChainOrderOrThrow(newBidOrder, slot).update(
					newBidOrder,
					getUserAccountOrThrow(bidNode)
				);

				// ask completely filled
				const newAskOrder = { ...askOrder };
				newAskOrder.baseAssetAmountFilled =
					askOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOnChainOrderOrThrow(newAskOrder, slot).update(
					newAskOrder,
					getUserAccountOrThrow(askNode)
				);

				nodesToFill.push({
					node: takerNode,
					makerNodes: [makerNode],
				});

				if (newAskOrder.baseAssetAmount.eq(newAskOrder.baseAssetAmountFilled)) {
					break;
				}
			}
		}

		return nodesToFill;
	}

	/**
	 * Decides which of a crossing ask/bid pair is the maker and which is the taker: if both are
	 * post-only, they can't be matched (`undefined`); if exactly one is post-only, it's the
	 * maker; otherwise whichever order's auction window (`order.slot + order.auctionDuration`)
	 * ends later is treated as the taker (it "arrived crossing" the earlier order).
	 *
	 * @param askNode the crossing ask node
	 * @param bidNode the crossing bid node
	 * @returns the assigned `{ takerNode, makerNode }`, or `undefined` if both orders are post-only and neither can take
	 */
	determineMakerAndTaker(
		askNode: DLOBNode,
		bidNode: DLOBNode
	): { takerNode: DLOBNode; makerNode: DLOBNode } | undefined {
		const askOrder = getOrderOrThrow(askNode);
		const bidOrder = getOrderOrThrow(bidNode);
		const askSlot = askOrder.slot.add(new BN(askOrder.auctionDuration));
		const bidSlot = bidOrder.slot.add(new BN(bidOrder.auctionDuration));

		if (bidOrder.postOnly && askOrder.postOnly) {
			return undefined;
		} else if (bidOrder.postOnly) {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		} else if (askOrder.postOnly) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else if (askSlot.lte(bidSlot)) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		}
	}

	/**
	 * Gets the best (lowest) resting-limit ask price for a market. Does not consider fallback
	 * (e.g. vAMM) liquidity.
	 *
	 * @param marketIndex the market to query
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns the best ask price, PRICE_PRECISION (1e6), or `undefined` if there are no resting-limit asks
	 */
	public getBestAsk<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		tickSize?: BN
	): BN | undefined {
		const bestAsk = this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			undefined,
			tickSize
		).next().value;

		if (bestAsk) {
			return bestAsk.getPrice(oraclePriceData, slot, tickSize);
		}
		return undefined;
	}

	/**
	 * Gets the best (highest) resting-limit bid price for a market. Does not consider fallback
	 * (e.g. vAMM) liquidity.
	 *
	 * @param marketIndex the market to query
	 * @param slot current slot
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param oraclePriceData oracle price data for the market
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns the best bid price, PRICE_PRECISION (1e6), or `undefined` if there are no resting-limit bids
	 */
	public getBestBid<T extends MarketType>(
		marketIndex: number,
		slot: number,
		marketType: T,
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData,
		tickSize?: BN
	): BN | undefined {
		const bestBid = this.getRestingLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			undefined,
			tickSize
		).next().value;

		if (bestBid) {
			return bestBid.getPrice(oraclePriceData, slot, tickSize);
		}
		return undefined;
	}

	/**
	 * Yields untriggered trigger orders that would close a position in `direction`: for a `long`
	 * position, short-direction orders in the `trigger.below` list (stop triggers on a price
	 * drop); for a `short` position, long-direction orders in `trigger.above` (stop triggers on a
	 * price rise). Includes both `triggerMarket` and `triggerLimit` order types — see
	 * `getStopLossMarkets`/`getStopLossLimits` to filter to one.
	 *
	 * @param marketIndex the market to scan
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param direction the direction of the position being protected (not the order's own direction)
	 * @returns a generator of stop-loss trigger order nodes
	 */
	public *getStopLosses(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.getMarketNodeLists(marketTypeStr, marketIndex);

		if (isVariant(direction, 'long') && marketNodeLists.trigger.below) {
			for (const node of marketNodeLists.trigger.below.getGenerator()) {
				if (isVariant(getOrderOrThrow(node).direction, 'short')) {
					yield node;
				}
			}
		} else if (isVariant(direction, 'short') && marketNodeLists.trigger.above) {
			for (const node of marketNodeLists.trigger.above.getGenerator()) {
				if (isVariant(getOrderOrThrow(node).direction, 'long')) {
					yield node;
				}
			}
		}
	}

	/** Same as `getStopLosses`, filtered to `triggerMarket` orders only. */
	public *getStopLossMarkets(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getStopLosses(marketIndex, marketType, direction)) {
			if (isVariant(getOrderOrThrow(node).orderType, 'triggerMarket')) {
				yield node;
			}
		}
	}

	/** Same as `getStopLosses`, filtered to `triggerLimit` orders only. */
	public *getStopLossLimits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getStopLosses(marketIndex, marketType, direction)) {
			if (isVariant(getOrderOrThrow(node).orderType, 'triggerLimit')) {
				yield node;
			}
		}
	}

	/**
	 * Yields untriggered trigger orders that would close a position in `direction` for profit:
	 * for a `long` position, short-direction orders in `trigger.above` (take-profit on a price
	 * rise); for a `short` position, long-direction orders in `trigger.below` (take-profit on a
	 * price drop). Includes both `triggerMarket` and `triggerLimit` order types — see
	 * `getTakeProfitMarkets`/`getTakeProfitLimits` to filter to one.
	 *
	 * @param marketIndex the market to scan
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param direction the direction of the position being protected (not the order's own direction)
	 * @returns a generator of take-profit trigger order nodes
	 */
	public *getTakeProfits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.getMarketNodeLists(marketTypeStr, marketIndex);

		if (isVariant(direction, 'long') && marketNodeLists.trigger.above) {
			for (const node of marketNodeLists.trigger.above.getGenerator()) {
				if (isVariant(getOrderOrThrow(node).direction, 'short')) {
					yield node;
				}
			}
		} else if (isVariant(direction, 'short') && marketNodeLists.trigger.below) {
			for (const node of marketNodeLists.trigger.below.getGenerator()) {
				if (isVariant(getOrderOrThrow(node).direction, 'long')) {
					yield node;
				}
			}
		}
	}

	/** Same as `getTakeProfits`, filtered to `triggerMarket` orders only. */
	public *getTakeProfitMarkets(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getTakeProfits(
			marketIndex,
			marketType,
			direction
		)) {
			if (isVariant(getOrderOrThrow(node).orderType, 'triggerMarket')) {
				yield node;
			}
		}
	}

	/** Same as `getTakeProfits`, filtered to `triggerLimit` orders only. */
	public *getTakeProfitLimits(
		marketIndex: number,
		marketType: MarketType,
		direction: PositionDirection
	): Generator<DLOBNode> {
		for (const node of this.getTakeProfits(
			marketIndex,
			marketType,
			direction
		)) {
			if (isVariant(getOrderOrThrow(node).orderType, 'triggerLimit')) {
				yield node;
			}
		}
	}

	/**
	 * Finds trigger orders whose condition is now satisfied by `triggerPrice`: `trigger.above`
	 * orders with `triggerPrice > order.triggerPrice`, and `trigger.below` orders with
	 * `triggerPrice < order.triggerPrice`. Both lists are sorted by trigger price with the
	 * nearest-to-triggering order at `head`, so each scan walks from `head` and `break`s at the
	 * first order that isn't (yet) triggered. Returns `[]` immediately if the exchange is paused.
	 *
	 * @param marketIndex the market to scan
	 * @param slot current slot (currently unused by the scan itself, reserved for future use)
	 * @param triggerPrice the price to check trigger conditions against, PRICE_PRECISION (1e6) — typically the current oracle or mark price
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param stateAccount global protocol state, used for the exchange-pause check
	 * @returns `NodeToTrigger`s for every order ready to be triggered on-chain
	 */
	public findNodesToTrigger(
		marketIndex: number,
		slot: number,
		triggerPrice: BN,
		marketType: MarketType,
		stateAccount: StateAccount
	): NodeToTrigger[] {
		if (exchangePaused(stateAccount)) {
			return [];
		}

		const nodesToTrigger: NodeToTrigger[] = [];
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.orderLists
			.get(marketTypeStr)
			?.get(marketIndex);

		const triggerAboveList = marketNodeLists
			? marketNodeLists.trigger.above
			: undefined;
		if (triggerAboveList) {
			for (
				let node = triggerAboveList.head;
				node !== undefined;
				node = node.next
			) {
				if (triggerPrice.gt(node.order.triggerPrice)) {
					nodesToTrigger.push({
						node: node,
					});
				} else {
					break;
				}
			}
		}

		const triggerBelowList = marketNodeLists
			? marketNodeLists.trigger.below
			: undefined;
		if (triggerBelowList) {
			for (
				let node = triggerBelowList.head;
				node !== undefined;
				node = node.next
			) {
				if (triggerPrice.lt(node.order.triggerPrice)) {
					nodesToTrigger.push({
						node: node,
					});
				} else {
					break;
				}
			}
		}

		return nodesToTrigger;
	}

	/**
	 * Debug helper: logs the market's best bid, best ask, and mid price (all resting-limit only,
	 * no fallback liquidity), along with each side's spread to the current oracle price, as a
	 * percentage.
	 *
	 * @param velocityClient client used to resolve market accounts and oracle price data
	 * @param slotSubscriber source of the current slot
	 * @param marketIndex the market to print
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @throws if the market currently has no resting-limit bid or ask (best bid/ask is `undefined`)
	 */
	public printTop(
		velocityClient: VelocityClient,
		slotSubscriber: SlotSubscriber,
		marketIndex: number,
		marketType: MarketType
	) {
		if (isVariant(marketType, 'perp')) {
			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				velocityClient.getMMOracleDataForPerpMarket(marketIndex);

			const bestAsk = this.getBestAsk(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			if (bestAsk === undefined || bestBid === undefined) {
				throw new Error(
					`printTop requires both a best ask and best bid for market ${marketIndex}`
				);
			}
			const mid = bestAsk.add(bestBid).div(new BN(2));

			const bidSpread =
				(convertToNumber(bestBid, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;
			const askSpread =
				(convertToNumber(bestAsk, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;

			const name = decodeName(
				velocityClient.getPerpMarketAccountOrThrow(marketIndex).name
			);
			console.log(`Market ${name} Orders`);
			console.log(
				`  Ask`,
				convertToNumber(bestAsk, PRICE_PRECISION).toFixed(3),
				`(${askSpread.toFixed(4)}%)`
			);
			console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(3));
			console.log(
				`  Bid`,
				convertToNumber(bestBid, PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		} else if (isVariant(marketType, 'spot')) {
			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				velocityClient.getOracleDataForSpotMarket(marketIndex);

			const bestAsk = this.getBestAsk(
				marketIndex,
				slot,
				MarketType.SPOT,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				slot,
				MarketType.SPOT,
				oraclePriceData
			);
			if (bestAsk === undefined || bestBid === undefined) {
				throw new Error(
					`printTop requires both a best ask and best bid for market ${marketIndex}`
				);
			}
			const mid = bestAsk.add(bestBid).div(new BN(2));

			const bidSpread =
				(convertToNumber(bestBid, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;
			const askSpread =
				(convertToNumber(bestAsk, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;

			const name = decodeName(
				velocityClient.getSpotMarketAccountOrThrow(marketIndex).name
			);
			console.log(`Market ${name} Orders`);
			console.log(
				`  Ask`,
				convertToNumber(bestAsk, PRICE_PRECISION).toFixed(3),
				`(${askSpread.toFixed(4)}%)`
			);
			console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(3));
			console.log(
				`  Bid`,
				convertToNumber(bestBid, PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		}
	}

	/** Flattens every order across every `NodeList` (perp and spot, all categories/sides) into a single `DLOBOrders` array of `{ user, order }` pairs, in no particular cross-list order. */
	public getDLOBOrders(): DLOBOrders {
		const dlobOrders: DLOBOrders = [];

		for (const nodeList of this.getNodeLists()) {
			for (const node of nodeList.getGenerator()) {
				dlobOrders.push({
					user: new PublicKey(getUserAccountOrThrow(node)),
					order: getOrderOrThrow(node),
				});
			}
		}

		return dlobOrders;
	}

	/** Yields every `NodeList` (all ten category/side combinations, per market) across every perp market, then every spot market. Used by `getOrder`/`getDLOBOrders` to walk the entire book. */
	*getNodeLists(): Generator<NodeList<DLOBNodeType>> {
		for (const [_, nodeLists] of this.getOrderListsForMarketType('perp')) {
			yield nodeLists.restingLimit.bid;
			yield nodeLists.restingLimit.ask;
			yield nodeLists.takingLimit.bid;
			yield nodeLists.takingLimit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}

		for (const [_, nodeLists] of this.getOrderListsForMarketType('spot')) {
			yield nodeLists.restingLimit.bid;
			yield nodeLists.restingLimit.ask;
			yield nodeLists.takingLimit.bid;
			yield nodeLists.takingLimit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}
	}

	/**
	 * Get an L2 (aggregated price/size) view of the order book for a given market: resting-limit
	 * DLOB liquidity merged with any supplied fallback generators (e.g. the vAMM, via
	 * `getVammL2Generator`), then bucketed into up to `depth` levels per side via `createL2Levels`.
	 * Does not include taking (still-auctioning) orders — only resting-limit makers and fallback
	 * liquidity are represented.
	 *
	 * @param marketIndex the market to build a book for
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param slot current slot, used to resolve resting-limit order prices
	 * @param oraclePriceData oracle price data for the market
	 * @param depth how many price levels of the order book to return, per side
	 * @param fallbackL2Generators additional non-DLOB liquidity sources to merge in, e.g. `getVammL2Generator`'s output; defaults to `[]`
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6), threaded into all DLOB price lookups; defaults to no rounding if omitted
	 * @returns the merged `L2OrderBook`, tagged with the given `slot`
	 */
	public getL2<T extends MarketType>({
		marketIndex,
		marketType,
		slot,
		oraclePriceData,
		depth,
		fallbackL2Generators = [],
		tickSize,
	}: {
		marketIndex: number;
		marketType: T;
		slot: number;
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData;
		depth: number;
		fallbackL2Generators?: L2OrderBookGenerator[];
		tickSize?: BN;
	}): L2OrderBook {
		const makerAskL2LevelGenerator = getL2GeneratorFromDLOBNodes(
			this.getRestingLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			),
			oraclePriceData,
			slot,
			tickSize
		);

		const fallbackAskGenerators = fallbackL2Generators.map(
			(fallbackL2Generator) => {
				return fallbackL2Generator.getL2Asks();
			}
		);

		const askL2LevelGenerator = mergeL2LevelGenerators(
			[makerAskL2LevelGenerator, ...fallbackAskGenerators],
			(a, b) => {
				return a.price.lt(b.price);
			}
		);

		const asks = createL2Levels(askL2LevelGenerator, depth);

		const makerBidGenerator = getL2GeneratorFromDLOBNodes(
			this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				undefined,
				tickSize
			),
			oraclePriceData,
			slot,
			tickSize
		);

		const fallbackBidGenerators = fallbackL2Generators.map((fallbackOrders) => {
			return fallbackOrders.getL2Bids();
		});

		const bidL2LevelGenerator = mergeL2LevelGenerators(
			[makerBidGenerator, ...fallbackBidGenerators],
			(a, b) => {
				return a.price.gt(b.price);
			}
		);

		const bids = createL2Levels(bidL2LevelGenerator, depth);

		return {
			bids,
			asks,
			slot,
		};
	}

	/**
	 * Get an L3 (individual resting order) view of the order book for a given market. Only
	 * resting-limit orders are included — no taking orders and no fallback (e.g. vAMM) liquidity.
	 *
	 * @param marketIndex the market to build a book for
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param slot current slot, used to resolve resting-limit order prices
	 * @param oraclePriceData oracle price data for the market
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns the `L3OrderBook`, tagged with the given `slot`
	 */
	public getL3<T extends MarketType>({
		marketIndex,
		marketType,
		slot,
		oraclePriceData,
		tickSize,
	}: {
		marketIndex: number;
		marketType: T;
		slot: number;
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData;
		tickSize?: BN;
	}): L3OrderBook {
		const bids: L3Level[] = [];
		const asks: L3Level[] = [];

		const restingAsks = this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			undefined,
			tickSize
		);

		for (const ask of restingAsks) {
			const askOrder = getOrderOrThrow(ask);
			asks.push({
				price: ask.getPriceOrThrow(oraclePriceData, slot, tickSize),
				size: askOrder.baseAssetAmount.sub(askOrder.baseAssetAmountFilled),
				maker: new PublicKey(getUserAccountOrThrow(ask)),
				orderId: askOrder.orderId,
			});
		}

		const restingBids = this.getRestingLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			undefined,
			tickSize
		);

		for (const bid of restingBids) {
			const bidOrder = getOrderOrThrow(bid);
			bids.push({
				price: bid.getPriceOrThrow(oraclePriceData, slot, tickSize),
				size: bidOrder.baseAssetAmount.sub(bidOrder.baseAssetAmountFilled),
				maker: new PublicKey(getUserAccountOrThrow(bid)),
				orderId: bidOrder.orderId,
			});
		}

		return {
			bids,
			asks,
			slot,
		};
	}

	private estimateFillExactBaseAmountInForSide(
		baseAmountIn: BN,
		oraclePriceData: OraclePriceData,
		slot: number,
		dlobSide: Generator<DLOBNode>,
		tickSize?: BN
	): BN {
		let runningSumQuote = ZERO;
		let runningSumBase = ZERO;
		for (const side of dlobSide) {
			const price = side.getPriceOrThrow(oraclePriceData, slot, tickSize); //side.order.quoteAssetAmount.div(side.order.baseAssetAmount);
			const sideOrder = getOrderOrThrow(side);
			const baseAmountRemaining = sideOrder.baseAssetAmount.sub(
				sideOrder.baseAssetAmountFilled
			);
			if (runningSumBase.add(baseAmountRemaining).gt(baseAmountIn)) {
				const remainingBase = baseAmountIn.sub(runningSumBase);
				runningSumBase = runningSumBase.add(remainingBase);
				runningSumQuote = runningSumQuote.add(remainingBase.mul(price));
				break;
			} else {
				runningSumBase = runningSumBase.add(baseAmountRemaining);
				runningSumQuote = runningSumQuote.add(baseAmountRemaining.mul(price));
			}
		}

		return runningSumQuote
			.mul(QUOTE_PRECISION)
			.div(BASE_PRECISION.mul(PRICE_PRECISION));
	}

	/**
	 * Estimates the quote amount that would be filled for a given base amount, walking
	 * resting-limit asks (for a `long`/buy) or bids (for a `short`/sell) from best price outward
	 * and summing `price * size` until `baseAmount` is consumed. Does not include fallback (e.g.
	 * vAMM) liquidity or taking orders, and does not mutate any order state — this is a read-only
	 * estimate, not a simulated fill.
	 *
	 * @param marketIndex the market to estimate against
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param baseAmount the base amount to fill, BASE_PRECISION (1e9)
	 * @param orderDirection direction of the hypothetical taker order (`long` walks asks, `short` walks bids)
	 * @param slot current slot, used to resolve resting-limit order prices
	 * @param oraclePriceData oracle price data for the market
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns the estimated quote amount filled, QUOTE_PRECISION (1e6); if resting liquidity is thinner than `baseAmount`, the result silently reflects only the liquidity that was actually walked (no error/flag for partial fill), and is `0` if there is no resting liquidity on that side at all
	 * @throws if `orderDirection` is neither `long` nor `short`
	 */
	public estimateFillWithExactBaseAmount<T extends MarketType>({
		marketIndex,
		marketType,
		baseAmount,
		orderDirection,
		slot,
		oraclePriceData,
		tickSize,
	}: {
		marketIndex: number;
		marketType: T;
		baseAmount: BN;
		orderDirection: PositionDirection;
		slot: number;
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData;
		tickSize?: BN;
	}): BN {
		if (isVariant(orderDirection, 'long')) {
			return this.estimateFillExactBaseAmountInForSide(
				baseAmount,
				oraclePriceData,
				slot,
				this.getRestingLimitAsks(
					marketIndex,
					slot,
					marketType,
					oraclePriceData,
					undefined,
					tickSize
				),
				tickSize
			);
		} else if (isVariant(orderDirection, 'short')) {
			return this.estimateFillExactBaseAmountInForSide(
				baseAmount,
				oraclePriceData,
				slot,
				this.getRestingLimitBids(
					marketIndex,
					slot,
					marketType,
					oraclePriceData,
					undefined,
					tickSize
				),
				tickSize
			);
		}
		throw new Error(
			`Invalid order direction ${getVariant(
				orderDirection
			)}: must be long or short`
		);
	}

	/**
	 * Collects the pubkeys of up to `numMakers` distinct makers currently resting best-priced on
	 * one side of the book — bids for a `long` taker, asks for a `short` taker — in best-price
	 * order. Used to pick candidate maker accounts to pass as `remaining_accounts` when
	 * submitting a fill instruction. A maker with multiple resting orders at different prices
	 * only counts once toward `numMakers`.
	 *
	 * @param marketIndex the market to scan
	 * @param marketType `MarketType.PERP` or `MarketType.SPOT`
	 * @param direction direction of the taker order being matched (`long` collects bid-side makers, `short` collects ask-side makers)
	 * @param slot current slot, used to resolve resting-limit order prices
	 * @param oraclePriceData oracle price data for the market
	 * @param numMakers maximum number of distinct maker pubkeys to return
	 * @param tickSize market order tick size, PRICE_PRECISION (1e6); defaults to no rounding if omitted
	 * @returns up to `numMakers` distinct maker `PublicKey`s, best price first
	 */
	public getBestMakers<T extends MarketType>({
		marketIndex,
		marketType,
		direction,
		slot,
		oraclePriceData,
		numMakers,
		tickSize,
	}: {
		marketIndex: number;
		marketType: T;
		direction: PositionDirection;
		slot: number;
		oraclePriceData: T extends { spot: unknown }
			? OraclePriceData
			: MMOraclePriceData;
		numMakers: number;
		tickSize?: BN;
	}): PublicKey[] {
		const makers = new Map<string, PublicKey>();
		const generator = isVariant(direction, 'long')
			? this.getRestingLimitBids(
					marketIndex,
					slot,
					marketType,
					oraclePriceData,
					undefined,
					tickSize
			  )
			: this.getRestingLimitAsks(
					marketIndex,
					slot,
					marketType,
					oraclePriceData,
					undefined,
					tickSize
			  );

		for (const node of generator) {
			const userAccount = getUserAccountOrThrow(node);
			if (!makers.has(userAccount)) {
				makers.set(userAccount, new PublicKey(userAccount));
			}

			if (makers.size === numMakers) {
				break;
			}
		}

		return Array.from(makers.values());
	}
}
