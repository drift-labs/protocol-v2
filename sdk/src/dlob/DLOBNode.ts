import {
	AMM_RESERVE_PRECISION,
	BN,
	convertToNumber,
	getLimitPrice,
	isVariant,
	MarketAccount,
	MARK_PRICE_PRECISION,
	OraclePriceData,
	Order,
	ZERO,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { getOrderId } from './NodeList';

export interface DLOBNode {
	getPrice(oraclePriceData: OraclePriceData, slot: number): BN;
	isVammNode(): boolean;
	order: Order | undefined;
	haveFilled: boolean;
	userAccount: PublicKey | undefined;
	market: MarketAccount;
}

export abstract class OrderNode implements DLOBNode {
	order: Order;
	market: MarketAccount;
	userAccount: PublicKey;
	sortValue: BN;
	marketAccount: MarketAccount;
	haveFilled = false;
	haveTrigger = false;

	constructor(order: Order, market: MarketAccount, userAccount: PublicKey) {
		this.order = order;
		this.market = market;
		this.userAccount = userAccount;
		this.sortValue = this.getSortValue(order);
	}

	abstract getSortValue(order: Order): BN;

	public getLabel(): string {
		let msg = `Order ${getOrderId(this.order, this.userAccount)}`;
		msg += ` ${isVariant(this.order.direction, 'long') ? 'LONG' : 'SHORT'} `;
		msg += `${convertToNumber(
			this.order.baseAssetAmount,
			AMM_RESERVE_PRECISION
		).toFixed(3)}`;
		if (this.order.price.gt(ZERO)) {
			msg += ` @ ${convertToNumber(
				this.order.price,
				MARK_PRICE_PRECISION
			).toFixed(3)}`;
		}
		if (this.order.triggerPrice.gt(ZERO)) {
			msg += ` ${
				isVariant(this.order.triggerCondition, 'below') ? 'BELOW' : 'ABOVE'
			}`;
			msg += ` ${convertToNumber(
				this.order.triggerPrice,
				MARK_PRICE_PRECISION
			).toFixed(3)}`;
		}
		return msg;
	}

	getPrice(oraclePriceData: OraclePriceData, slot: number): BN {
		return getLimitPrice(this.order, this.market, oraclePriceData, slot);
	}

	isVammNode(): boolean {
		return false;
	}
}

export class LimitOrderNode extends OrderNode {
	next?: LimitOrderNode;
	previous?: LimitOrderNode;

	getSortValue(order: Order): BN {
		return order.price;
	}
}

export class FloatingLimitOrderNode extends OrderNode {
	next?: FloatingLimitOrderNode;
	previous?: FloatingLimitOrderNode;

	getSortValue(order: Order): BN {
		return order.oraclePriceOffset;
	}
}

export class MarketOrderNode extends OrderNode {
	next?: MarketOrderNode;
	previous?: MarketOrderNode;

	getSortValue(order: Order): BN {
		return order.slot;
	}
}

export class TriggerOrderNode extends OrderNode {
	next?: TriggerOrderNode;
	previous?: TriggerOrderNode;

	getSortValue(order: Order): BN {
		return order.triggerPrice;
	}
}

export type DLOBNodeMap = {
	limit: LimitOrderNode;
	floatingLimit: FloatingLimitOrderNode;
	market: MarketOrderNode;
	trigger: TriggerOrderNode;
};

export type DLOBNodeType =
	| 'limit'
	| 'floatingLimit'
	| 'market'
	| ('trigger' & keyof DLOBNodeMap);

export function createNode<T extends DLOBNodeType>(
	nodeType: T,
	order: Order,
	market: MarketAccount,
	userAccount: PublicKey
): DLOBNodeMap[T] {
	switch (nodeType) {
		case 'floatingLimit':
			return new FloatingLimitOrderNode(order, market, userAccount);
		case 'limit':
			return new LimitOrderNode(order, market, userAccount);
		case 'market':
			return new MarketOrderNode(order, market, userAccount);
		case 'trigger':
			return new TriggerOrderNode(order, market, userAccount);
		default:
			throw Error(`Unknown DLOBNode type ${nodeType}`);
	}
}
