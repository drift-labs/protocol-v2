import { OptionalOrderParams, OrderTriggerCondition, OrderType } from './types';
import { BN } from '@coral-xyz/anchor';

export function getLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType' | 'marketType'> & { price: BN }
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.LIMIT,
	});
}

export function getTriggerMarketOrderParams(
	params: Omit<OptionalOrderParams, 'orderType' | 'marketType'> & {
		triggerCondition: OrderTriggerCondition;
		triggerPrice: BN;
	}
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.TRIGGER_MARKET,
	});
}

export function getTriggerLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType' | 'marketType'> & {
		triggerCondition: OrderTriggerCondition;
		triggerPrice: BN;
		price: BN;
	}
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.TRIGGER_LIMIT,
	});
}

export function getMarketOrderParams(
	params: Omit<OptionalOrderParams, 'orderType' | 'marketType'>
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.MARKET,
	});
}
