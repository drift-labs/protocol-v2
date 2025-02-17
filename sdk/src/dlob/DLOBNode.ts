import {
	AMM_RESERVE_PRECISION,
	BN,
	convertToNumber,
	getLimitPrice,
	isVariant,
	PRICE_PRECISION,
	OraclePriceData,
	Order,
	ZERO,
} from '..';
// import { PublicKey } from '@solana/web3.js';
import { getOrderSignature } from './NodeList';

export interface DLOBNode {
	getPrice(oraclePriceData: OraclePriceData, slot: number): BN;
	isVammNode(): boolean;
	order: Order | undefined;
	isBaseFilled(): boolean;
	haveFilled: boolean;
	userAccount: string | undefined;
	isProtectedMaker: boolean;
	applyProtectedMakerOffset: boolean;
	isSignedMsg: boolean | undefined;
}

export abstract class OrderNode implements DLOBNode {
	order: Order;
	userAccount: string;
	sortValue: BN;
	haveFilled = false;
	haveTrigger = false;
	isProtectedMaker: boolean;
	applyProtectedMakerOffset: boolean;
	isSignedMsg: boolean;

	constructor(
		order: Order,
		userAccount: string,
		isProtectedMaker: boolean,
		applyProtectedMakerOffset: boolean,
		isSignedMsg = false
	) {
		// Copy the order over to the node
		this.order = { ...order };
		this.userAccount = userAccount;
		this.sortValue = this.getSortValue(order);
		this.isProtectedMaker = isProtectedMaker;
		this.applyProtectedMakerOffset = applyProtectedMakerOffset;
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

	getPrice(oraclePriceData: OraclePriceData, slot: number): BN {
		return getLimitPrice(
			this.order,
			oraclePriceData,
			slot,
			undefined,
			this.applyProtectedMakerOffset && this.isProtectedMaker
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
		if (this.applyProtectedMakerOffset && this.isProtectedMaker) {
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

	constructor(order: Order, userAccount: string) {
		super(order, userAccount, false, false, true);
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
	applyProtectedMakerOffset: boolean
): DLOBNodeMap[T] {
	switch (nodeType) {
		case 'floatingLimit':
			return new FloatingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				applyProtectedMakerOffset
			);
		case 'protectedFloatingLimit':
			return new FloatingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				applyProtectedMakerOffset
			);
		case 'restingLimit':
			return new RestingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				applyProtectedMakerOffset
			);
		case 'takingLimit':
			return new TakingLimitOrderNode(
				order,
				userAccount,
				isProtectedMaker,
				applyProtectedMakerOffset
			);
		case 'market':
			return new MarketOrderNode(order, userAccount, isProtectedMaker, false);
		case 'trigger':
			return new TriggerOrderNode(order, userAccount, isProtectedMaker, false);
		case 'signedMsg':
			return new SignedMsgOrderNode(order, userAccount);
		default:
			throw Error(`Unknown DLOBNode type ${nodeType}`);
	}
}
