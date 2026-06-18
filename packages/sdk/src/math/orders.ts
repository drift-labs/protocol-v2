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

export function standardizeBaseAssetAmount(
	baseAssetAmount: BN,
	stepSize: BN
): BN {
	const remainder = baseAssetAmount.mod(stepSize);
	return baseAssetAmount.sub(remainder);
}

export function standardizePrice(
	price: BN,
	tickSize: BN,
	direction: PositionDirection
): BN {
	if (price.eq(ZERO)) {
		console.log('price is zero');
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

export function getLimitPrice<T extends MarketTypeStr>(
	order: Order,
	oraclePriceData: T extends 'spot' ? OraclePriceData : MMOraclePriceData,
	slot: number,
	fallbackPrice?: BN
): BN | undefined {
	if (hasAuctionPrice(order, slot)) {
		return getAuctionPrice(order, slot, oraclePriceData.price);
	} else if (!order.oraclePriceOffset.eq(ZERO)) {
		return BN.max(oraclePriceData.price.add(order.oraclePriceOffset), ONE);
	} else if (order.price.eq(ZERO)) {
		return fallbackPrice;
	} else {
		return order.price;
	}
}

export function hasLimitPrice(order: Order, slot: number): boolean {
	return (
		order.price.gt(ZERO) ||
		!order.oraclePriceOffset.eq(ZERO) ||
		!isAuctionComplete(order, slot)
	);
}

export function hasAuctionPrice(order: Order, slot: number): boolean {
	return (
		!isAuctionComplete(order, slot) &&
		(!order.auctionStartPrice.eq(ZERO) || !order.auctionEndPrice.eq(ZERO))
	);
}

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

export function calculateBaseAssetAmountForAmmToFulfill(
	order: Order,
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	slot: number
): BN {
	if (mustBeTriggered(order) && !isTriggered(order)) {
		return ZERO;
	}

	const limitPrice = getLimitPrice(order, mmOraclePriceData, slot);
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

export function isMarketOrder(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['market', 'triggerMarket', 'oracle']);
}

export function isLimitOrder(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['limit', 'triggerLimit']);
}

export function mustBeTriggered(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['triggerMarket', 'triggerLimit']);
}

export function isTriggered(order: Order): boolean {
	return isOneOfVariant(order.triggerCondition, [
		'triggeredAbove',
		'triggeredBelow',
	]);
}

export function isRestingLimitOrder(order: Order, slot: number): boolean {
	if (!isLimitOrder(order)) {
		return false;
	}

	return order.postOnly || isAuctionComplete(order, slot);
}

const FLAG_IS_SIGNED_MSG = 0x01;
export function isSignedMsgOrder(order: Order): boolean {
	return (order.bitFlags & FLAG_IS_SIGNED_MSG) !== 0;
}

const FLAG_HAS_BUILDER = 0x10;
export function hasBuilder(order: Order): boolean {
	return (order.bitFlags & FLAG_HAS_BUILDER) !== 0;
}

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
 * Invert the size-premium liability weight: given a target margin ratio (liability weight),
 * return the max `size` (AMM_RESERVE_PRECISION units) that still yields <= target.
 *
 * Returns:
 * - BN size (>=0) if bounded
 * - null if impossible (target < liabilityWeight) OR imfFactor == 0 (unbounded)
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

	// cap at max OI
	const maxOpenInterest = market.maxOpenInterest;
	if (lo.gt(maxOpenInterest)) {
		return maxOpenInterest;
	}

	return lo;
}
