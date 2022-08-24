import {
	MarketType,
	OptionalOrderParams,
	OrderTriggerCondition,
	OrderType,
} from './types';
import { BN } from '@project-serum/anchor';

export function getLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & { price: BN }
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.LIMIT,
		marketType: MarketType.PERP,
	});
}

export function getTriggerMarketOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & {
		triggerCondition: OrderTriggerCondition;
		triggerPrice: BN;
	}
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.TRIGGER_MARKET,
		marketType: MarketType.PERP,
	});
}

export function getTriggerLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & {
		triggerCondition: OrderTriggerCondition;
		triggerPrice: BN;
		price: BN;
	}
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.TRIGGER_LIMIT,
		marketType: MarketType.PERP,
	});
}

export function getMarketOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'>
): OptionalOrderParams {
	return Object.assign({}, params, {
		orderType: OrderType.MARKET,
		marketType: MarketType.PERP,
	});
}
