import {
	OrderParams,
	OrderTriggerCondition,
	OrderType,
	PositionDirection,
} from './types';
import { BN } from '@project-serum/anchor';
import { ZERO } from './constants/numericConstants';

export function getLimitOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	baseAssetAmount: BN,
	price: BN,
	reduceOnly: boolean,
	discountToken = false,
	referrer = false,
	userOrderId = 0,
	postOnly = false,
	oraclePriceOffset = ZERO,
	immediateOrCancel = false
): OrderParams {
	return {
		orderType: OrderType.LIMIT,
		userOrderId,
		marketIndex,
		direction,
		quoteAssetAmount: ZERO,
		baseAssetAmount,
		price,
		reduceOnly,
		postOnly,
		immediateOrCancel,
		positionLimit: ZERO,
		padding0: true,
		padding1: ZERO,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition: OrderTriggerCondition.ABOVE,
		triggerPrice: ZERO,
		oraclePriceOffset,
	};
}

export function getTriggerMarketOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	baseAssetAmount: BN,
	triggerPrice: BN,
	triggerCondition: OrderTriggerCondition,
	reduceOnly: boolean,
	discountToken = false,
	referrer = false,
	userOrderId = 0
): OrderParams {
	return {
		orderType: OrderType.TRIGGER_MARKET,
		userOrderId,
		marketIndex,
		direction,
		quoteAssetAmount: ZERO,
		baseAssetAmount,
		price: ZERO,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		positionLimit: ZERO,
		padding0: true,
		padding1: ZERO,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition,
		triggerPrice,
		oraclePriceOffset: ZERO,
	};
}

export function getTriggerLimitOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	baseAssetAmount: BN,
	price: BN,
	triggerPrice: BN,
	triggerCondition: OrderTriggerCondition,
	reduceOnly: boolean,
	discountToken = false,
	referrer = false,
	userOrderId = 0
): OrderParams {
	return {
		orderType: OrderType.TRIGGER_LIMIT,
		userOrderId,
		marketIndex,
		direction,
		quoteAssetAmount: ZERO,
		baseAssetAmount,
		price,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		positionLimit: ZERO,
		padding0: true,
		padding1: ZERO,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition,
		triggerPrice,
		oraclePriceOffset: ZERO,
	};
}

export function getMarketOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	quoteAssetAmount: BN,
	baseAssetAmount: BN,
	reduceOnly: boolean,
	price = ZERO,
	discountToken = false,
	referrer = false
): OrderParams {
	if (baseAssetAmount.eq(ZERO) && quoteAssetAmount.eq(ZERO)) {
		throw Error('baseAssetAmount or quoteAssetAmount must be zero');
	}

	return {
		orderType: OrderType.MARKET,
		userOrderId: 0,
		marketIndex,
		direction,
		quoteAssetAmount,
		baseAssetAmount,
		price,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		positionLimit: ZERO,
		padding0: true,
		padding1: ZERO,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition: OrderTriggerCondition.ABOVE,
		triggerPrice: ZERO,
		oraclePriceOffset: ZERO,
	};
}
