import {
	DefaultOrderParams,
	OptionalOrderParams,
	OrderParams,
	OrderTriggerCondition,
	OrderType,
} from './types';
import { BN } from './isomorphic/anchor';

/**
 * Builds `OptionalOrderParams` for a resting limit order (`OrderType.LIMIT`).
 * Unlike a market order, a limit order has no auction and rests on the book at `price` until
 * filled, cancelled, or expired.
 * @param params - Order fields (see `OrderParams`); `baseAssetAmount` is in BASE_PRECISION
 * (1e9), `price` is in PRICE_PRECISION (1e6). `orderType` is set automatically and must not be
 * passed in.
 * @returns Params merged onto `DefaultOrderParams`, ready to pass to `placeOrder`/`placePerpOrder`.
 */
export function getLimitOrderParams(
	params: Omit<OptionalOrderParams, 'orderType'> & { price: BN }
): OptionalOrderParams {
	return getOrderParams(
		Object.assign({}, params, {
			orderType: OrderType.LIMIT,
		})
	);
}

/**
 * Builds `OptionalOrderParams` for a trigger market order (`OrderType.TRIGGER_MARKET`) — a
 * conditional order (e.g. stop-loss/take-profit) that becomes an auctioned market order once the
 * oracle price crosses `triggerPrice` per `triggerCondition`.
 * @param params - Order fields (see `OrderParams`); `baseAssetAmount` and `triggerPrice` use
 * BASE_PRECISION (1e9) and PRICE_PRECISION (1e6) respectively. `orderType` is set automatically.
 * @returns Params merged onto `DefaultOrderParams`, ready to pass to `placeOrder`/`placePerpOrder`.
 */
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

/**
 * Builds `OptionalOrderParams` for a trigger limit order (`OrderType.TRIGGER_LIMIT`) — a
 * conditional order that becomes a resting limit order at `price` once the oracle price crosses
 * `triggerPrice` per `triggerCondition`.
 * @param params - Order fields (see `OrderParams`); `baseAssetAmount`, `triggerPrice`, and `price`
 * use BASE_PRECISION (1e9) and PRICE_PRECISION (1e6) respectively. `orderType` is set automatically.
 * @returns Params merged onto `DefaultOrderParams`, ready to pass to `placeOrder`/`placePerpOrder`.
 */
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

/**
 * Builds `OptionalOrderParams` for a market order (`OrderType.MARKET`), filled immediately via a
 * Dutch auction between `auctionStartPrice` and `auctionEndPrice` (defaults derived on-chain from
 * the oracle price if omitted) over `auctionDuration` slots.
 * @param params - Order fields (see `OrderParams`); `baseAssetAmount` is in BASE_PRECISION (1e9),
 * any price fields are in PRICE_PRECISION (1e6). `orderType` is set automatically and must not be
 * passed in.
 * @returns Params merged onto `DefaultOrderParams`, ready to pass to `placeOrder`/`placePerpOrder`.
 */
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
 * Merges `optionalOrderParams` onto `DefaultOrderParams` (filling in any field the caller omitted,
 * e.g. `marketType: MarketType.PERP`, `reduceOnly: false`, no trigger/oracle-offset), then applies
 * `overridingParams` on top of that. Used internally by the `get*OrderParams` factories; call it
 * directly only if you need to force a field that a factory doesn't expose.
 *
 * example:
 * ```
 * const orderParams = getOrderParams(optionalOrderParams, { marketType: MarketType.PERP });
 * ```
 *
 * @param optionalOrderParams - Required order fields plus any optional `OrderParams` overrides.
 * @param overridingParams - Fields applied last, taking precedence over both the defaults and
 * `optionalOrderParams`.
 * @returns A fully-populated `OrderParams` object.
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
