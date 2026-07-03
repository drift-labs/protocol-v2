import { BN } from '../isomorphic/anchor';
import {
	AMM_RESERVE_PRECISION,
	PRICE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { getLimitPrice } from '../math/orders';
import { isVariant, MarketTypeStr, Order } from '../types';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import { convertToNumber } from '../math/conversion';
import { getOrderSignature } from './NodeList';

/**
 * Picks the oracle price data shape a `DLOBNode` needs to compute its limit price for a given
 * market type: `OraclePriceData` for spot markets, `MMOraclePriceData` (which layers in the
 * market-maker oracle) for perp markets.
 */
export type NodeOraclePriceData<T extends MarketTypeStr = MarketTypeStr> =
	T extends 'spot' ? OraclePriceData : MMOraclePriceData;

/**
 * A single order sitting in the DLOB, indexed by one of the sorted `NodeList`s. Wraps one
 * on-chain `Order` plus DLOB-local bookkeeping (fill progress, sort key) used by
 * `DLOB`'s crossing/fill-finding and L2/L3 book construction.
 */
export interface DLOBNode {
	/**
	 * Computes the node's current limit price, or `undefined` if it has none right now (e.g. a
	 * market/auction order still mid-auction with no fallback price, or an unset oracle-offset
	 * order below the tick floor). Callers that can tolerate "no price" (market orders crossing
	 * on a taker/maker basis, fallback-liquidity checks) should use this; callers that require a
	 * price to proceed should use `getPriceOrThrow` instead.
	 *
	 * @param oraclePriceData current oracle price data for the node's market (price in
	 *   PRICE_PRECISION, 1e6)
	 * @param slot current slot, used to resolve auction/oracle-offset pricing
	 * @param tickSize market's order tick size, PRICE_PRECISION (1e6); when omitted this
	 *   effectively rounds to the smallest price unit (no meaningful rounding) — pass the
	 *   market's `orderTickSize` to match on-chain price standardization
	 * @returns limit price, PRICE_PRECISION (1e6), or `undefined` if the node has no price yet
	 */
	getPrice<T extends MarketTypeStr>(
		oraclePriceData: NodeOraclePriceData<T>,
		slot: number,
		tickSize?: BN
	): BN | undefined;
	/**
	 * Same as `getPrice`, but throws instead of returning `undefined` when the node has no limit
	 * price. Use this wherever a missing price would be a bug (e.g. iterating resting limit
	 * orders, which always have a determinable price once the auction is complete).
	 *
	 * @param oraclePriceData current oracle price data for the node's market (price in
	 *   PRICE_PRECISION, 1e6)
	 * @param slot current slot, used to resolve auction/oracle-offset pricing
	 * @param tickSize market's order tick size, PRICE_PRECISION (1e6); defaults to no rounding
	 *   if omitted
	 * @returns limit price, PRICE_PRECISION (1e6)
	 * @throws if the underlying order has no limit price at this slot
	 */
	getPriceOrThrow<T extends MarketTypeStr>(
		oraclePriceData: NodeOraclePriceData<T>,
		slot: number,
		tickSize?: BN
	): BN;
	/** True for synthetic vAMM liquidity nodes (not backed by an on-chain `Order`); always `false` for `OrderNode` subclasses. */
	isVammNode(): boolean;
	/** The on-chain order this node mirrors, or `undefined` for non-order (e.g. vAMM) nodes. */
	order: Order | undefined;
	/** True once `order.baseAssetAmountFilled` equals `order.baseAssetAmount` (fully filled). */
	isBaseFilled(): boolean;
	/** DLOB-local flag set by crossing/fill-finding once this node has been matched in the current pass, so it isn't matched twice. */
	haveFilled: boolean;
	/** Base58 pubkey string of the `User` account that owns this order, or `undefined` if not applicable. */
	userAccount: string | undefined;
	/** True if this order arrived as an off-chain signed message (not yet landed on-chain) rather than a resting on-chain order. */
	isSignedMsg: boolean | undefined;
	/** Remaining base asset amount tracked by this node, BASE_PRECISION (1e9); defaults to `order.baseAssetAmount` if not overridden at insert time. */
	baseAssetAmount: BN;
}

/**
 * Base class for all order-backed DLOB nodes. Holds a defensive copy of the on-chain `Order`
 * plus a `sortValue` (the field each `NodeList` sorts on) computed by the concrete subclass's
 * `getSortValue`. Concrete subclasses (`RestingLimitOrderNode`, `TakingLimitOrderNode`, etc.)
 * only differ in which `Order` field they sort by and which `NodeList` bucket they belong to.
 */
export abstract class OrderNode implements DLOBNode {
	order: Order;
	userAccount: string;
	/** The value this node is sorted by within its `NodeList`; set from `getSortValue(order)` at construction and not auto-updated on order changes. */
	sortValue: BN;
	haveFilled = false;
	haveTrigger = false;
	baseAssetAmount: BN;
	isSignedMsg: boolean;

	/**
	 * @param order on-chain order to wrap; a shallow copy is stored so DLOB mutations don't alias the caller's object
	 * @param userAccount base58 pubkey string of the order's owner
	 * @param baseAssetAmount remaining base amount to track, BASE_PRECISION (1e9); defaults to `order.baseAssetAmount` (used for reduce-only orders where the fillable amount is smaller than the order's stated size)
	 * @param isSignedMsg whether this node represents an off-chain signed-message order rather than a resting on-chain order; defaults to `false`
	 */
	constructor(
		order: Order,
		userAccount: string,
		baseAssetAmount?: BN,
		isSignedMsg = false
	) {
		// Copy the order over to the node
		this.order = { ...order };
		this.userAccount = userAccount;
		this.sortValue = this.getSortValue(order);
		this.baseAssetAmount = baseAssetAmount ?? order.baseAssetAmount;
		this.isSignedMsg = isSignedMsg;
	}

	/** Returns the field of `order` this node type sorts on within its `NodeList` (e.g. price, slot, trigger price, or oracle offset). */
	abstract getSortValue(order: Order): BN;

	/** Builds a one-line human-readable summary of the order (id, side, size, price, trigger) for `NodeList.print`/`printTop` debugging output. */
	public getLabel(): string {
		let msg = `Order ${getOrderSignature(
			this.order.orderId,
			this.userAccount
		)}`;
		msg += ` ${isVariant(this.order.direction, 'long') ? 'LONG' : 'SHORT'} `;
		msg += `${convertToNumber(
			this.order.baseAssetAmount,
			AMM_RESERVE_PRECISION
		).toFixed(3)}`;
		if (this.order.price.gt(ZERO)) {
			msg += ` @ ${convertToNumber(this.order.price, PRICE_PRECISION).toFixed(
				3
			)}`;
		}
		if (this.order.triggerPrice.gt(ZERO)) {
			msg += ` ${
				isVariant(this.order.triggerCondition, 'below') ? 'BELOW' : 'ABOVE'
			}`;
			msg += ` ${convertToNumber(
				this.order.triggerPrice,
				PRICE_PRECISION
			).toFixed(3)}`;
		}
		return msg;
	}

	/** See `DLOBNode.getPrice`. Delegates to `getLimitPrice`, which resolves auction, oracle-offset, and fixed-price orders in that priority. */
	getPrice<T extends MarketTypeStr>(
		oraclePriceData: NodeOraclePriceData<T>,
		slot: number,
		tickSize?: BN
	): BN | undefined {
		return getLimitPrice<T>(
			this.order,
			oraclePriceData,
			slot,
			undefined,
			tickSize
		);
	}

	/** See `DLOBNode.getPriceOrThrow`. @throws if `getPrice` returns `undefined` for this order. */
	getPriceOrThrow<T extends MarketTypeStr>(
		oraclePriceData: NodeOraclePriceData<T>,
		slot: number,
		tickSize?: BN
	): BN {
		const price = this.getPrice<T>(oraclePriceData, slot, tickSize);
		if (price === undefined) {
			throw new Error(
				`OrderNode.getPrice: order ${this.order.orderId} has no limit price`
			);
		}
		return price;
	}

	/** True once the wrapped order's `baseAssetAmountFilled` equals its `baseAssetAmount` (BASE_PRECISION, 1e9). */
	isBaseFilled(): boolean {
		return this.order.baseAssetAmountFilled.eq(this.order.baseAssetAmount);
	}

	/** Always `false` — order-backed nodes are never vAMM nodes. */
	isVammNode(): boolean {
		return false;
	}
}

/** A limit order whose auction has not yet completed (still crossable as a taker); sorted ascending by `order.slot` (arrival order) within its `NodeList`. Promoted to a `RestingLimitOrderNode` once its auction completes or it settles as post-only, via `DLOB.updateRestingLimitOrders`. */
export class TakingLimitOrderNode extends OrderNode {
	next?: TakingLimitOrderNode;
	previous?: TakingLimitOrderNode;

	getSortValue(order: Order): BN {
		return order.slot;
	}
}

/** A limit order with a fixed (non-oracle-relative) price whose auction has completed, or that is post-only; sorted by `order.price` (PRICE_PRECISION, 1e6) — ascending for asks, descending for bids. This is the DLOB's standard resting maker order. */
export class RestingLimitOrderNode extends OrderNode {
	next?: RestingLimitOrderNode;
	previous?: RestingLimitOrderNode;

	getSortValue(order: Order): BN {
		return order.price;
	}
}

/** A resting limit order priced relative to the oracle (`oraclePriceOffset != 0`); sorted by `order.oraclePriceOffset` (PRICE_PRECISION, 1e6, signed) rather than an absolute price, since its effective price moves with the oracle. */
export class FloatingLimitOrderNode extends OrderNode {
	next?: FloatingLimitOrderNode;
	previous?: FloatingLimitOrderNode;

	getSortValue(order: Order): BN {
		return order.oraclePriceOffset;
	}
}

/** A market order (or an order otherwise treated as market/oracle-priced); sorted ascending by `order.slot` (arrival order) since market orders have no fixed price to sort by. */
export class MarketOrderNode extends OrderNode {
	next?: MarketOrderNode;
	previous?: MarketOrderNode;

	getSortValue(order: Order): BN {
		return order.slot;
	}
}

/** A trigger (stop-loss/take-profit) order that has not yet fired; sorted by `order.triggerPrice` (PRICE_PRECISION, 1e6) — ascending in the "above" list, descending in the "below" list — so `DLOB.findNodesToTrigger` can stop scanning as soon as the trigger price is no longer crossed. */
export class TriggerOrderNode extends OrderNode {
	next?: TriggerOrderNode;
	previous?: TriggerOrderNode;

	getSortValue(order: Order): BN {
		return order.triggerPrice;
	}
}

// We'll use the signedMsg uuid for the order id since it's not yet on-chain
/** An order that arrived as an off-chain signed message and has not yet landed on-chain; always constructed with `isSignedMsg = true`. Sorted ascending by `order.slot`. */
export class SignedMsgOrderNode extends OrderNode {
	next?: SignedMsgOrderNode;
	previous?: SignedMsgOrderNode;

	constructor(order: Order, userAccount: string, baseAssetAmount?: BN) {
		super(order, userAccount, baseAssetAmount, true);
	}

	getSortValue(order: Order): BN {
		return order.slot;
	}
}

/** Maps each `DLOBNodeType` key to its concrete `OrderNode` subclass; used to type `NodeList<T>` and `createNode`'s return value. */
export type DLOBNodeMap = {
	restingLimit: RestingLimitOrderNode;
	takingLimit: TakingLimitOrderNode;
	floatingLimit: FloatingLimitOrderNode;
	market: MarketOrderNode;
	trigger: TriggerOrderNode;
	signedMsg: SignedMsgOrderNode;
};

/** The discriminant used to pick which `NodeList` (and thus sort order) an order belongs in. */
export type DLOBNodeType =
	| 'signedMsg'
	| 'restingLimit'
	| 'takingLimit'
	| 'floatingLimit'
	| 'market'
	| ('trigger' & keyof DLOBNodeMap);

/**
 * Constructs the concrete `OrderNode` subclass for a given `DLOBNodeType`.
 *
 * @param nodeType which node subclass to build; determines the node's sort key (see `DLOBNodeMap`)
 * @param order on-chain order to wrap (copied, not mutated)
 * @param userAccount base58 pubkey string of the order's owner
 * @param baseAssetAmount remaining base amount to track, BASE_PRECISION (1e9); defaults to `order.baseAssetAmount`
 * @returns a new node instance of the type matching `nodeType`
 * @throws if `nodeType` is not one of the known `DLOBNodeType` values
 */
export function createNode<T extends DLOBNodeType>(
	nodeType: T,
	order: Order,
	userAccount: string,
	baseAssetAmount?: BN
): DLOBNodeMap[T] {
	switch (nodeType) {
		case 'floatingLimit':
			return new FloatingLimitOrderNode(order, userAccount, baseAssetAmount);
		case 'restingLimit':
			return new RestingLimitOrderNode(order, userAccount, baseAssetAmount);
		case 'takingLimit':
			return new TakingLimitOrderNode(order, userAccount, baseAssetAmount);
		case 'market':
			return new MarketOrderNode(order, userAccount, baseAssetAmount);
		case 'trigger':
			return new TriggerOrderNode(order, userAccount, baseAssetAmount);
		case 'signedMsg':
			return new SignedMsgOrderNode(order, userAccount, baseAssetAmount);
		default:
			throw Error(`Unknown DLOBNode type ${nodeType}`);
	}
}
