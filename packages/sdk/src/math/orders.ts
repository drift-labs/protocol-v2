import {
	isOneOfVariant,
	isVariant,
	PerpMarketAccount,
	AMM,
	MarketStats,
	Order,
	PositionDirection,
	MarketTypeStr,
	OrderBitFlag,
	StateAccount,
} from '../types';
import {
	ZERO,
	ONE,
	SPOT_MARKET_IMF_PRECISION,
	MARGIN_PRECISION,
} from '../constants/numericConstants';
import { BN } from '../isomorphic/anchor';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import {
	getAuctionPrice,
	isAuctionComplete,
	isFallbackAvailableLiquiditySource,
} from './auction';
import {
	calculateMaxBaseAssetAmountFillable,
	calculateMaxBaseAssetAmountToTrade,
	calculateUpdatedAMM,
} from './amm';
import { calculateSizePremiumLiabilityWeight } from './margin';

/** Rounds `baseAssetAmount` down to the nearest multiple of `stepSize` (always truncates toward zero — never rounds up), matching the on-chain order/fill step-size standardization. @param baseAssetAmount Amount to round, BASE_PRECISION (1e9). @param stepSize Market's order step size, BASE_PRECISION (1e9). @returns Amount rounded down to a `stepSize` multiple, BASE_PRECISION (1e9). */
export function standardizeBaseAssetAmount(
	baseAssetAmount: BN,
	stepSize: BN
): BN {
	const remainder = baseAssetAmount.mod(stepSize);
	return baseAssetAmount.sub(remainder);
}

/**
 * Rounds `price` to a multiple of `tickSize`, rounding in the direction that's conservative
 * for the order's side: down for a long (never overpay past the tick) and up for a short
 * (never undersell past the tick). Used across auction pricing and limit-price derivation so
 * every price the SDK produces already lines up with the market's `orderTickSize` before it
 * reaches the program, avoiding the on-chain tick-size rejection this standardization fix
 * addresses. A `tickSize <= 0` (unset/no constraint) or `price == 0` passes through
 * unchanged.
 * @param price Price to standardize, PRICE_PRECISION (1e6).
 * @param tickSize Market's order tick size, PRICE_PRECISION (1e6). Non-positive means "no tick constraint."
 * @param direction Order side; determines rounding direction.
 * @returns `price` rounded to the nearest tick in the conservative direction, PRICE_PRECISION (1e6).
 */
export function standardizePrice(
	price: BN,
	tickSize: BN,
	direction: PositionDirection
): BN {
	if (price.eq(ZERO)) {
		return price;
	}

	// A non-positive tick size means "no tick constraint" (e.g. unset markets);
	// on-chain markets always have tick_size >= 1, but guard against a zero
	// divisor rather than throwing.
	if (tickSize.lte(ZERO)) {
		return price;
	}

	const remainder = price.mod(tickSize);
	if (remainder.eq(ZERO)) {
		return price;
	}

	if (isVariant(direction, 'long')) {
		return price.sub(remainder);
	} else {
		return price.add(tickSize).sub(remainder);
	}
}

/**
 * Resolves an order's effective limit price at the current slot, standardized to
 * `tickSize`: the in-progress auction price while the auction hasn't completed, the
 * oracle-offset price for oracle-pegged orders, the order's fixed `price` if set, or
 * `fallbackPrice` (also standardized) for a market order with no price/offset/auction.
 * @param order Order to price.
 * @param oraclePriceData Oracle price source — use `MMOraclePriceData` for perp orders, `OraclePriceData` for spot.
 * @param slot Current slot, used to evaluate auction progress.
 * @param fallbackPrice Price to return for a market order with no auction/offset/fixed price (e.g. a mark or oracle price), PRICE_PRECISION (1e6).
 * @param tickSize Market's order tick size, PRICE_PRECISION (1e6). Defaults to `ONE` (no effective standardization).
 * @returns Limit price, PRICE_PRECISION (1e6); `undefined` if the order has no resolvable price and no `fallbackPrice` was given.
 */
export function getLimitPrice<T extends MarketTypeStr>(
	order: Order,
	oraclePriceData: T extends 'spot' ? OraclePriceData : MMOraclePriceData,
	slot: number,
	fallbackPrice?: BN,
	tickSize: BN = ONE
): BN | undefined {
	if (hasAuctionPrice(order, slot)) {
		return getAuctionPrice(order, slot, oraclePriceData.price, tickSize);
	} else if (!order.oraclePriceOffset.eq(ZERO)) {
		const limitPrice = BN.max(
			oraclePriceData.price.add(order.oraclePriceOffset),
			tickSize
		);
		return standardizePrice(limitPrice, tickSize, order.direction);
	} else if (order.price.eq(ZERO)) {
		return fallbackPrice === undefined
			? undefined
			: standardizePrice(fallbackPrice, tickSize, order.direction);
	} else {
		return order.price;
	}
}

/** True if the order has any way to resolve a limit price right now: a fixed `price`, a nonzero oracle offset, or an auction still in progress. */
export function hasLimitPrice(order: Order, slot: number): boolean {
	return (
		order.price.gt(ZERO) ||
		!order.oraclePriceOffset.eq(ZERO) ||
		!isAuctionComplete(order, slot)
	);
}

/** True if the order still has an active (incomplete) auction with a nonzero start or end price. */
export function hasAuctionPrice(order: Order, slot: number): boolean {
	return (
		!isAuctionComplete(order, slot) &&
		(!order.auctionStartPrice.eq(ZERO) || !order.auctionEndPrice.eq(ZERO))
	);
}

/**
 * True if the AMM is currently a fillable liquidity source for `order` — either it's
 * expired (always fillable to clean up), or the AMM has fillable size at the order's limit
 * price AND is an allowed liquidity source right now (`isFallbackAvailableLiquiditySource`,
 * which gates on oracle validity and low-risk-for-AMM classification).
 * @param order Order to check.
 * @param market Perp market the order is on.
 * @param mmOraclePriceData Current MM oracle price data.
 * @param slot Current slot.
 * @param ts Current unix timestamp (seconds), used for expiry.
 * @param state Global state, providing oracle guard rails and paused-operations flags.
 * @returns `true` if the AMM may currently fill this order.
 */
export function isFillableByVAMM(
	order: Order,
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	slot: number,
	ts: number,
	state: StateAccount
): boolean {
	return (
		(isFallbackAvailableLiquiditySource(
			order,
			mmOraclePriceData,
			slot,
			state,
			market
		) &&
			calculateBaseAssetAmountForAmmToFulfill(
				order,
				market,
				mmOraclePriceData,
				slot
			).gt(ZERO)) ||
		isOrderExpired(order, ts)
	);
}

/**
 * True if filling `order` against the AMM is considered low-risk even when the MM oracle
 * isn't fully valid, approximating `Order::is_low_risk_for_amm` in
 * `programs/velocity/src/state/user.rs`. Always false for spot orders. True when the order
 * was placed at or before the MM oracle's slot (so it can't be exploiting oracle staleness),
 * during liquidation, or when the order carries the `SafeTriggerOrder` bit flag.
 * @param order Order to check.
 * @param mmOraclePriceData Current MM oracle price data, used for its `slot`.
 * @param isLiquidation Whether the fill is part of a liquidation (always low-risk if so).
 * @returns `true` if the order is low-risk for an AMM fill under a degraded oracle.
 */
export function isLowRiskForAmm(
	order: Order,
	mmOraclePriceData: MMOraclePriceData,
	isLiquidation?: boolean
): boolean {
	if (isVariant(order.marketType, 'spot')) {
		return false;
	}

	const orderOlderThanOracleDelay = new BN(order.slot).lte(
		mmOraclePriceData.slot
	);

	return (
		orderOlderThanOracleDelay ||
		isLiquidation ||
		(order.bitFlags & OrderBitFlag.SafeTriggerOrder) !== 0
	);
}

/**
 * Calculates how much of `order` the AMM can currently fill, capped by both the order's
 * limit price (via `calculateBaseAssetAmountToFillUpToLimitPrice`, standardized to
 * `market.orderTickSize`) and the AMM's own max fillable size
 * (`calculateMaxBaseAssetAmountFillable`). Returns zero for a not-yet-triggered
 * trigger order. Prices against `calculateUpdatedAMM` (i.e. the repegged/curve-updated AMM
 * state), not the raw stored reserves.
 * @param order Order to evaluate.
 * @param market Perp market the order is on.
 * @param mmOraclePriceData Current MM oracle price data.
 * @param slot Current slot.
 * @returns Fillable base asset amount, BASE_PRECISION (1e9).
 */
export function calculateBaseAssetAmountForAmmToFulfill(
	order: Order,
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	slot: number
): BN {
	if (mustBeTriggered(order) && !isTriggered(order)) {
		return ZERO;
	}

	const limitPrice = getLimitPrice(
		order,
		mmOraclePriceData,
		slot,
		undefined,
		market.orderTickSize
	);
	let baseAssetAmount;

	const updatedAMM = calculateUpdatedAMM(market.amm, mmOraclePriceData);
	if (limitPrice !== undefined) {
		baseAssetAmount = calculateBaseAssetAmountToFillUpToLimitPrice(
			order,
			updatedAMM,
			market.marketStats,
			market.orderStepSize,
			market.orderTickSize,
			limitPrice,
			mmOraclePriceData
		);
	} else {
		baseAssetAmount = order.baseAssetAmount.sub(order.baseAssetAmountFilled);
	}

	const maxBaseAssetAmount = calculateMaxBaseAssetAmountFillable(
		updatedAMM,
		market.orderStepSize,
		order.direction
	);

	return BN.min(maxBaseAssetAmount, baseAssetAmount);
}

/**
 * Calculates how much base asset the AMM can trade against `order` without crossing its
 * limit price, adjusting the limit by one tick in the order's favor (so the AMM never fills
 * exactly at the boundary) before asking `calculateMaxBaseAssetAmountToTrade` how much
 * inventory the AMM has at that price. Returns zero if the AMM would only trade in the
 * opposite direction from the order. Caps the result at the order's unfilled remainder.
 * @param order Order being filled.
 * @param amm AMM state to trade against.
 * @param marketStats Market stats needed to compute spread reserves.
 * @param orderStepSize Market's order step size, BASE_PRECISION (1e9), used to standardize the result.
 * @param orderTickSize Market's order tick size, PRICE_PRECISION (1e6), used to adjust the limit price by one tick.
 * @param limitPrice Order's limit price, PRICE_PRECISION (1e6).
 * @param mmOraclePriceData Current MM oracle price data.
 * @returns Fillable base asset amount up to the limit price, BASE_PRECISION (1e9).
 */
export function calculateBaseAssetAmountToFillUpToLimitPrice(
	order: Order,
	amm: AMM,
	marketStats: MarketStats,
	orderStepSize: BN,
	orderTickSize: BN,
	limitPrice: BN,
	mmOraclePriceData: MMOraclePriceData
): BN {
	const adjustedLimitPrice = isVariant(order.direction, 'long')
		? limitPrice.sub(orderTickSize)
		: limitPrice.add(orderTickSize);

	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		amm,
		marketStats,
		adjustedLimitPrice,
		order.direction,
		mmOraclePriceData
	);

	const baseAssetAmount = standardizeBaseAssetAmount(
		maxAmountToTrade,
		orderStepSize
	);

	// Check that directions are the same
	const sameDirection = isSameDirection(direction, order.direction);
	if (!sameDirection) {
		return ZERO;
	}

	const baseAssetAmountUnfilled = order.baseAssetAmount.sub(
		order.baseAssetAmountFilled
	);
	return baseAssetAmount.gt(baseAssetAmountUnfilled)
		? baseAssetAmountUnfilled
		: baseAssetAmount;
}

function isSameDirection(
	firstDirection: PositionDirection,
	secondDirection: PositionDirection
): boolean {
	return (
		(isVariant(firstDirection, 'long') && isVariant(secondDirection, 'long')) ||
		(isVariant(firstDirection, 'short') && isVariant(secondDirection, 'short'))
	);
}

/**
 * True if `order.maxTs` has passed as of `ts`. Never true for trigger orders, non-`open`
 * orders, or orders with no expiry (`maxTs == 0`).
 * @param order Order to check.
 * @param ts Current unix timestamp (seconds).
 * @param enforceBuffer If true, extends `maxTs` by `bufferSeconds` before comparing, but only for limit orders (default false) — gives resting limit orders a grace period before being treated as expired.
 * @param bufferSeconds Grace period in seconds applied when `enforceBuffer` is true (default 15).
 * @returns `true` if the order has expired.
 */
export function isOrderExpired(
	order: Order,
	ts: number,
	enforceBuffer = false,
	bufferSeconds = 15
): boolean {
	if (
		mustBeTriggered(order) ||
		!isVariant(order.status, 'open') ||
		order.maxTs.eq(ZERO)
	) {
		return false;
	}

	let maxTs;
	if (enforceBuffer && isLimitOrder(order)) {
		maxTs = order.maxTs.addn(bufferSeconds);
	} else {
		maxTs = order.maxTs;
	}

	return new BN(ts).gt(maxTs);
}

/** True if `order.orderType` is `market`, `triggerMarket`, or `oracle`. */
export function isMarketOrder(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['market', 'triggerMarket', 'oracle']);
}

/** True if `order.orderType` is `limit` or `triggerLimit`. */
export function isLimitOrder(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['limit', 'triggerLimit']);
}

/** True if the order requires a trigger condition to fire before it becomes fillable (`triggerMarket`/`triggerLimit`). */
export function mustBeTriggered(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['triggerMarket', 'triggerLimit']);
}

/** True if a trigger order's condition has already fired (`triggeredAbove`/`triggeredBelow`). */
export function isTriggered(order: Order): boolean {
	return isOneOfVariant(order.triggerCondition, [
		'triggeredAbove',
		'triggeredBelow',
	]);
}

/** True if a limit order currently rests on the book — i.e. it's `postOnly`, or its auction (if any) has completed. Always false for non-limit orders. */
export function isRestingLimitOrder(order: Order, slot: number): boolean {
	if (!isLimitOrder(order)) {
		return false;
	}

	return order.postOnly || isAuctionComplete(order, slot);
}

/** True if the order was submitted via the signed-message (swift/off-chain relay) path (`OrderBitFlag.SignedMessage`). */
export function isSignedMsgOrder(order: Order): boolean {
	return (order.bitFlags & OrderBitFlag.SignedMessage) !== 0;
}

/** True if the order carries a builder-fee attribution (`OrderBitFlag.HasBuilder`) — the associated builder is entitled to a fee cut on fill. */
export function hasBuilder(order: Order): boolean {
	return (order.bitFlags & OrderBitFlag.HasBuilder) !== 0;
}

/**
 * Resolves the effective base asset amount for a reduce-only order: caps it so the order
 * can't flip the position through zero (a reduce-only long can close at most the existing
 * short, and vice versa). Non-reduce-only orders pass through `order.baseAssetAmount`
 * unchanged.
 * @param order Order to resolve.
 * @param existingBaseAssetAmount Current position size before this order fills, BASE_PRECISION (1e9, signed).
 * @returns Effective base asset amount, BASE_PRECISION (1e9).
 */
export function calculateOrderBaseAssetAmount(
	order: Order,
	existingBaseAssetAmount: BN
): BN {
	if (!order.reduceOnly) {
		return order.baseAssetAmount;
	}

	if (isVariant(order.direction, 'long')) {
		return BN.min(
			BN.min(existingBaseAssetAmount, ZERO).abs(),
			order.baseAssetAmount
		);
	} else {
		return BN.min(BN.max(existingBaseAssetAmount, ZERO), order.baseAssetAmount);
	}
}

// ---------- inverse ----------
/**
 * Inverts `calculateSizePremiumLiabilityWeight` via binary search: given a target margin ratio
 * (liability weight), finds the largest position `size` whose size-premium-adjusted liability
 * weight is still `<= target`. Used to size down an order/position to stay under a margin-ratio
 * target as size grows (the on-chain weight increases with `sqrt(size)` via `imfFactor`).
 * @param target Target (max acceptable) liability weight, MARGIN_PRECISION (1e4).
 * @param imfFactor Market's initial-margin-fraction scaling factor, SPOT_MARKET_IMF_PRECISION-scaled.
 * @param liabilityWeight Market's base (zero-size) liability weight, MARGIN_PRECISION (1e4).
 * @param market Perp market providing `maxOpenInterest` as a final cap on the result.
 * @returns Max size, AMM_RESERVE_PRECISION (1e9), capped at `market.maxOpenInterest` (a zero `maxOpenInterest` means uncapped, per on-chain convention); `null` if `target < liabilityWeight` (impossible) or `imfFactor` is zero (weight is size-invariant, so no size bounds it).
 */
export function maxSizeForTargetLiabilityWeightBN(
	target: BN,
	imfFactor: BN,
	liabilityWeight: BN,
	market: PerpMarketAccount
): BN | null {
	if (target.lt(liabilityWeight)) return null;
	if (imfFactor.isZero()) return null;

	const base = liabilityWeight.muln(4).divn(5);

	const denom = new BN(100_000)
		.mul(SPOT_MARKET_IMF_PRECISION)
		.div(MARGIN_PRECISION);
	if (denom.isZero())
		throw new Error('denom=0: bad precision/spotImfPrecision');

	const allowedInc = target.gt(base) ? target.sub(base) : ZERO;

	const maxSqrt = allowedInc.mul(denom).div(imfFactor);

	if (maxSqrt.lte(ZERO)) {
		const fitsZero = calculateSizePremiumLiabilityWeight(
			ZERO,
			imfFactor,
			liabilityWeight,
			MARGIN_PRECISION
		).lte(target);
		return fitsZero ? ZERO : null;
	}

	let hi = maxSqrt.mul(maxSqrt).sub(ONE).divn(10);
	if (hi.isNeg()) hi = ZERO;

	let lo = ZERO;
	while (lo.lt(hi)) {
		const mid = lo.add(hi).add(ONE).divn(2); // upper mid to prevent infinite loop
		if (
			calculateSizePremiumLiabilityWeight(
				mid,
				imfFactor,
				liabilityWeight,
				MARGIN_PRECISION
			).lte(target)
		) {
			lo = mid;
		} else {
			hi = mid.sub(ONE);
		}
	}

	// cap at max OI. A maxOpenInterest of 0 means no configured cap (unlimited),
	// matching the on-chain convention — do not treat it as a hard cap of 0.
	const maxOpenInterest = market.maxOpenInterest;
	if (!maxOpenInterest.isZero() && lo.gt(maxOpenInterest)) {
		return maxOpenInterest;
	}

	return lo;
}
