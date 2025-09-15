import { BN } from '@coral-xyz/anchor';
import {
	AMM_RESERVE_PRECISION,
	PRICE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { getLimitPrice } from '../math/orders';
import {
	isVariant,
	MarketTypeStr,
	Order,
	ProtectedMakerParams,
} from '../types';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import { convertToNumber } from '../math/conversion';
import { getOrderSignature } from './NodeList';

export interface DLOBNode {
	getPrice<T extends MarketTypeStr>(
		oraclePriceData: T extends 'spot' ? OraclePriceData : MMOraclePriceData,
		slot: number
	): BN;
	isVammNode(): boolean;
	order: Order | undefined;
	isBaseFilled(): boolean;
	haveFilled: boolean;
	userAccount: string | undefined;
	isProtectedMaker: boolean;
	protectedMakerParams?: ProtectedMakerParams;
	isSignedMsg: boolean | undefined;
	baseAssetAmount: BN;
}

export abstract class OrderNode implements DLOBNode {
	order: Order;
	userAccount: string;
	sortValue: BN;
	haveFilled = false;
	haveTrigger = false;
	isProtectedMaker: boolean;
	protectedMakerParams?: ProtectedMakerParams;
	baseAssetAmount: BN;
	isSignedMsg: boolean;

	constructor(
		order: Order,
		userAccount: string,
		isProtectedMaker: boolean,
		protectedMakerParams?: ProtectedMakerParams,
		baseAssetAmount?: BN,
		isSignedMsg = false
	) {
		// Copy the order over to the node
		this.order = { ...order };
		this.userAccount = userAccount;
		this.sortValue = this.getSortValue(order);
		this.isProtectedMaker = isProtectedMaker;
		this.protectedMakerParams = protectedMakerParams;
		this.baseAssetAmount = baseAssetAmount ?? order.baseAssetAmount;
		this.isSignedMsg = isSignedMsg;
	}

	abstract getSortValue(order: Order): BN;

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

	getPrice<T extends MarketTypeStr>(
		oraclePriceData: T extends 'spot' ? OraclePriceData : MMOraclePriceData,
		slot: number
	): BN {
		return getLimitPrice<T>(
			this.order,
			oraclePriceData,
			slot,
			undefined,
			this.isProtectedMaker ? this.protectedMakerParams : undefined
		);
	}

	isBaseFilled(): boolean {
		return this.order.baseAssetAmountFilled.eq(this.order.baseAssetAmount);
	}

	isVammNode(): boolean {
		return false;
	}
}

export class TakingLimitOrderNode extends OrderNode {
	next?: TakingLimitOrderNode;
	previous?: TakingLimitOrderNode;

	getSortValue(order: Order): BN {
		return order.slot;
	}
}

export class RestingLimitOrderNode extends OrderNode {
	next?: RestingLimitOrderNode;
	previous?: RestingLimitOrderNode;

	getSortValue(order: Order): BN {
		let sortValue = order.price;
		if (this.protectedMakerParams && this.isProtectedMaker) {
			const offset = sortValue.divn(1000);

			if (isVariant(order.direction, 'long')) {
				sortValue = sortValue.sub(offset);
			} else {
				sortValue = sortValue.add(offset);
			}
		}
		return sortValue;
	}
}

export class FloatingLimitOrderNode extends OrderNode {
	next?: FloatingLimitOrderNode;
	previous?: FloatingLimitOrderNode;

	getSortValue(order: Order): BN {
		return new BN(order.oraclePriceOffset);
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

// We'll use the signedMsg uuid for the order id since it's not yet on-chain
export class SignedMsgOrderNode extends OrderNode {
	next?: SignedMsgOrderNode;
	previous?: SignedMsgOrderNode;

	constructor(order: Order, userAccount: string, baseAssetAmount?: BN) {
		super(order, userAccount, false, undefined, baseAssetAmount, true);
	}

	getSortValue(order: Order): BN {
		return order.slot;
	}
}

export type DLOBNodeMap = {
	restingLimit: RestingLimitOrderNode;
	takingLimit: TakingLimitOrderNode;
	floatingLimit: FloatingLimitOrderNode;
	protectedFloatingLimit: FloatingLimitOrderNode;
	market: MarketOrderNode;
	trigger: TriggerOrderNode;
	signedMsg: SignedMsgOrderNode;
};

export type DLOBNodeType =
	| 'signedMsg'
	| 'restingLimit'
	| 'takingLimit'
	| 'floatingLimit'
	| 'protectedFloatingLimit'
	| 'market'
	| ('trigger' & keyof DLOBNodeMap);

export function createNode<T extends DLOBNodeType>(
	nodeType: T,
	order: Order,
	userAccount: string,
	isProtectedMaker: boolean,
	protectedMakerParams?: ProtectedMakerParams,
	baseAssetAmount?: BN
): DLOBNodeMap[T] {
	switch (nodeType) {
		case 'floatingLimit':
			return new FloatingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				protectedMakerParams,
				baseAssetAmount
			);
		case 'protectedFloatingLimit':
			return new FloatingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				protectedMakerParams,
				baseAssetAmount
			);
		case 'restingLimit':
			return new RestingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				protectedMakerParams,
				baseAssetAmount
			);
		case 'takingLimit':
			return new TakingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				protectedMakerParams,
				baseAssetAmount
			);
		case 'market':
			return new MarketOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				undefined,
				baseAssetAmount
			);
		case 'trigger':
			return new TriggerOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				undefined,
				baseAssetAmount
			);
		case 'signedMsg':
			return new SignedMsgOrderNode(order, userAccount, baseAssetAmount);
		default:
			throw Error(`Unknown DLOBNode type ${nodeType}`);
	}
}
