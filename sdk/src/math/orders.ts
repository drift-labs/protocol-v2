import {
	isOneOfVariant,
	isVariant,
	PerpMarketAccount,
	AMM,
	Order,
	PositionDirection,
	ProtectedMakerParams,
} from '../types';
import { ZERO, TWO, ONE } from '../constants/numericConstants';
import { BN } from '@coral-xyz/anchor';
import { OraclePriceData } from '../oracles/types';
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
import { standardizeBaseAssetAmount } from './utils';
import { IUser } from '../user/types';

export function isOrderRiskIncreasing(user: IUser, order: Order): boolean {
	if (!isVariant(order.status, 'open')) {
		return false;
	}

	const position =
		user.getPerpPosition(order.marketIndex) ||
		user.getEmptyPosition(order.marketIndex);

	// if no position exists, it's risk increasing
	if (position.baseAssetAmount.eq(ZERO)) {
		return true;
	}

	// if position is long and order is long
	if (position.baseAssetAmount.gt(ZERO) && isVariant(order.direction, 'long')) {
		return true;
	}

	// if position is short and order is short
	if (
		position.baseAssetAmount.lt(ZERO) &&
		isVariant(order.direction, 'short')
	) {
		return true;
	}

	const baseAssetAmountToFill = order.baseAssetAmount.sub(
		order.baseAssetAmountFilled
	);
	// if order will flip position
	if (baseAssetAmountToFill.gt(position.baseAssetAmount.abs().mul(TWO))) {
		return true;
	}

	return false;
}

export function isOrderRiskIncreasingInSameDirection(
	user: IUser,
	order: Order
): boolean {
	if (!isVariant(order.status, 'open')) {
		return false;
	}

	const position =
		user.getPerpPosition(order.marketIndex) ||
		user.getEmptyPosition(order.marketIndex);

	// if no position exists, it's risk increasing
	if (position.baseAssetAmount.eq(ZERO)) {
		return true;
	}

	// if position is long and order is long
	if (position.baseAssetAmount.gt(ZERO) && isVariant(order.direction, 'long')) {
		return true;
	}

	// if position is short and order is short
	if (
		position.baseAssetAmount.lt(ZERO) &&
		isVariant(order.direction, 'short')
	) {
		return true;
	}

	return false;
}

export function isOrderReduceOnly(user: IUser, order: Order): boolean {
	if (!isVariant(order.status, 'open')) {
		return false;
	}

	const position =
		user.getPerpPosition(order.marketIndex) ||
		user.getEmptyPosition(order.marketIndex);

	// if position is long and order is long
	if (
		position.baseAssetAmount.gte(ZERO) &&
		isVariant(order.direction, 'long')
	) {
		return false;
	}

	// if position is short and order is short
	if (
		position.baseAssetAmount.lte(ZERO) &&
		isVariant(order.direction, 'short')
	) {
		return false;
	}

	return true;
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

export function getLimitPrice(
	order: Order,
	oraclePriceData: OraclePriceData,
	slot: number,
	fallbackPrice?: BN,
	protectedMakerParams?: ProtectedMakerParams
): BN | undefined {
	let limitPrice;
	if (hasAuctionPrice(order, slot)) {
		limitPrice = getAuctionPrice(order, slot, oraclePriceData.price);
	} else if (order.oraclePriceOffset !== 0) {
		limitPrice = BN.max(
			oraclePriceData.price.add(new BN(order.oraclePriceOffset)),
			ONE
		);
	} else if (order.price.eq(ZERO)) {
		limitPrice = fallbackPrice;
	} else {
		limitPrice = order.price;
	}

	if (protectedMakerParams) {
		limitPrice = applyProtectedMakerParams(
			limitPrice,
			order.direction,
			protectedMakerParams
		);
	}

	return limitPrice;
}

export function applyProtectedMakerParams(
	limitPrice: BN,
	direction: PositionDirection,
	protectedMakerParams: ProtectedMakerParams
): BN {
	const minOffset = protectedMakerParams.tickSize.muln(8);
	let limitPriceBpsDivisor;
	if (protectedMakerParams.limitPriceDivisor > 0) {
		limitPriceBpsDivisor = 10000 / protectedMakerParams.limitPriceDivisor;
	} else {
		limitPriceBpsDivisor = 1000;
	}

	const limitPriceOffset = BN.min(
		BN.max(
			BN.max(limitPrice.divn(limitPriceBpsDivisor), minOffset),
			protectedMakerParams.dynamicOffset
		),
		limitPrice.divn(20)
	);

	if (isVariant(direction, 'long')) {
		return BN.max(
			limitPrice.sub(limitPriceOffset),
			protectedMakerParams.tickSize
		);
	} else {
		return limitPrice.add(limitPriceOffset);
	}
}

export function hasLimitPrice(order: Order, slot: number): boolean {
	return (
		order.price.gt(ZERO) ||
		order.oraclePriceOffset != 0 ||
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
	oraclePriceData: OraclePriceData,
	slot: number,
	ts: number,
	minAuctionDuration: number
): boolean {
	return (
		(isFallbackAvailableLiquiditySource(order, minAuctionDuration, slot) &&
			calculateBaseAssetAmountForAmmToFulfill(
				order,
				market,
				oraclePriceData,
				slot
			).gte(market.amm.minOrderSize)) ||
		isOrderExpired(order, ts)
	);
}

export function calculateBaseAssetAmountForAmmToFulfill(
	order: Order,
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	slot: number
): BN {
	if (mustBeTriggered(order) && !isTriggered(order)) {
		return ZERO;
	}

	const limitPrice = getLimitPrice(order, oraclePriceData, slot);
	let baseAssetAmount;

	const updatedAMM = calculateUpdatedAMM(market.amm, oraclePriceData);
	if (limitPrice !== undefined) {
		baseAssetAmount = calculateBaseAssetAmountToFillUpToLimitPrice(
			order,
			updatedAMM,
			limitPrice,
			oraclePriceData
		);
	} else {
		baseAssetAmount = order.baseAssetAmount.sub(order.baseAssetAmountFilled);
	}

	const maxBaseAssetAmount = calculateMaxBaseAssetAmountFillable(
		updatedAMM,
		order.direction
	);

	return BN.min(maxBaseAssetAmount, baseAssetAmount);
}

export function calculateBaseAssetAmountToFillUpToLimitPrice(
	order: Order,
	amm: AMM,
	limitPrice: BN,
	oraclePriceData: OraclePriceData
): BN {
	const adjustedLimitPrice = isVariant(order.direction, 'long')
		? limitPrice.sub(amm.orderTickSize)
		: limitPrice.add(amm.orderTickSize);

	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		amm,
		adjustedLimitPrice,
		order.direction,
		oraclePriceData
	);

	const baseAssetAmount = standardizeBaseAssetAmount(
		maxAmountToTrade,
		amm.orderStepSize
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

export function isTakingOrder(order: Order, slot: number): boolean {
	return isMarketOrder(order) || !isRestingLimitOrder(order, slot);
}

const FLAG_IS_SIGNED_MSG = 0x01;
export function isSignedMsgOrder(order: Order): boolean {
	return (order.bitFlags & FLAG_IS_SIGNED_MSG) !== 0;
}
