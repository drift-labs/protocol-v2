import {
	DefaultOrderParams,
	OptionalOrderParams,
	OrderParams,
	OrderTriggerCondition,
	OrderType,
} from './types';
import { BN } from '@coral-xyz/anchor';

export function getLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & { price: BN }
): OptionalOrderParams {
	return getOrderParams(
		Object.assign({}, params, {
			orderType: OrderType.LIMIT,
		})
	);
}

export function getTriggerMarketOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & {
		triggerCondition: OrderTriggerCondition;
		triggerPrice: BN;
	}
): OptionalOrderParams {
	return getOrderParams(
		Object.assign({}, params, {
			orderType: OrderType.TRIGGER_MARKET,
		})
	);
}

export function getTriggerLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & {
		triggerCondition: OrderTriggerCondition;
		triggerPrice: BN;
		price: BN;
	}
): OptionalOrderParams {
	return getOrderParams(
		Object.assign({}, params, {
			orderType: OrderType.TRIGGER_LIMIT,
		})
	);
}

export function getMarketOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'>
): OptionalOrderParams {
	return getOrderParams(
		Object.assign({}, params, {
			orderType: OrderType.MARKET,
		})
	);
}

/**
 * Creates an OrderParams object with the given OptionalOrderParams and any params to override.
 *
 * example:
 * ```
 * const orderParams = getOrderParams(optionalOrderParams, { marketType: MarketType.PERP });
 * ```
 *
 * @param optionalOrderParams
 * @param overridingParams
 * @returns
 */
export function getOrderParams(
	optionalOrderParams: OptionalOrderParams,
	overridingParams: Record<string, any> = {}
): OrderParams {
	return Object.assign(
		{},
		DefaultOrderParams,
		optionalOrderParams,
		overridingParams
	);
}
