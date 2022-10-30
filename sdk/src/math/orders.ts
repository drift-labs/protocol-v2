import { User } from '../user';
import {
	isOneOfVariant,
	isVariant,
	PerpMarketAccount,
	Order,
	PositionDirection,
} from '../types';
import { ZERO, TWO } from '../constants/numericConstants';
import { BN } from '@project-serum/anchor';
import { OraclePriceData } from '../oracles/types';
import { getAuctionPrice, isAuctionComplete } from './auction';
import {
	calculateMaxBaseAssetAmountFillable,
	calculateMaxBaseAssetAmountToTrade,
} from './amm';

export function isOrderRiskIncreasing(user: User, order: Order): boolean {
	if (isVariant(order.status, 'init')) {
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
	user: User,
	order: Order
): boolean {
	if (isVariant(order.status, 'init')) {
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

export function isOrderReduceOnly(user: User, order: Order): boolean {
	if (isVariant(order.status, 'init')) {
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

export function standardizeBaseAssetAmount(
	baseAssetAmount: BN,
	stepSize: BN
): BN {
	const remainder = baseAssetAmount.mod(stepSize);
	return baseAssetAmount.sub(remainder);
}

export function getLimitPrice(
	order: Order,
	oraclePriceData: OraclePriceData,
	slot: number
): BN {
	let limitPrice;
	if (order.oraclePriceOffset !== 0) {
		limitPrice = oraclePriceData.price.add(new BN(order.oraclePriceOffset));
	} else if (isOneOfVariant(order.orderType, ['market', 'triggerMarket'])) {
		if (!isAuctionComplete(order, slot)) {
			limitPrice = getAuctionPrice(order, slot);
		} else if (!order.price.eq(ZERO)) {
			limitPrice = order.price;
		} else {
			// check oracle validity?
			const oraclePrice1Pct = oraclePriceData.price.div(new BN(100));
			if (isVariant(order.direction, 'long')) {
				limitPrice = oraclePriceData.price.add(oraclePrice1Pct);
			} else {
				limitPrice = oraclePriceData.price.sub(oraclePrice1Pct);
			}
		}
	} else {
		limitPrice = order.price;
	}

	return limitPrice;
}

export function getOptionalLimitPrice(
	order: Order,
	oraclePriceData: OraclePriceData,
	slot: number
): BN | undefined {
	if (hasLimitPrice(order, slot)) {
		return getLimitPrice(order, oraclePriceData, slot);
	} else {
		return undefined;
	}
}

export function hasLimitPrice(order: Order, slot: number): boolean {
	return (
		order.price.gt(ZERO) ||
		order.oraclePriceOffset != 0 ||
		!isAuctionComplete(order, slot)
	);
}

export function isFillableByVAMM(
	order: Order,
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	slot: number,
	ts: number
): boolean {
	return (
		(isAuctionComplete(order, slot) &&
			!calculateBaseAssetAmountForAmmToFulfill(
				order,
				market,
				oraclePriceData,
				slot
			).eq(ZERO)) ||
		isOrderExpired(order, ts)
	);
}

export function calculateBaseAssetAmountForAmmToFulfill(
	order: Order,
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	slot: number
): BN {
	if (
		isOneOfVariant(order.orderType, ['triggerMarket', 'triggerLimit']) &&
		order.triggered === false
	) {
		return ZERO;
	}

	const limitPrice = getOptionalLimitPrice(order, oraclePriceData, slot);
	let baseAssetAmount;
	if (limitPrice !== undefined) {
		baseAssetAmount = calculateBaseAssetAmountToFillUpToLimitPrice(
			order,
			market,
			limitPrice,
			oraclePriceData
		);
	} else {
		baseAssetAmount = order.baseAssetAmount.sub(order.baseAssetAmountFilled);
	}

	const maxBaseAssetAmount = calculateMaxBaseAssetAmountFillable(
		market.amm,
		order.direction
	);

	return BN.min(maxBaseAssetAmount, baseAssetAmount);
}

export function calculateBaseAssetAmountToFillUpToLimitPrice(
	order: Order,
	market: PerpMarketAccount,
	limitPrice: BN,
	oraclePriceData: OraclePriceData
): BN {
	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		market.amm,
		limitPrice,
		order.direction,
		oraclePriceData
	);

	const baseAssetAmount = standardizeBaseAssetAmount(
		maxAmountToTrade,
		market.amm.orderStepSize
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

export function isOrderExpired(order: Order, ts: number): boolean {
	if (
		isOneOfVariant(order.orderType, ['triggerMarket', 'triggerLimit']) ||
		!isVariant(order.status, 'open') ||
		order.maxTs.eq(ZERO)
	) {
		return false;
	}

	return new BN(ts).gt(order.maxTs);
}

export function isMarketOrder(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['market', 'triggerMarket']);
}

export function isLimitOrder(order: Order): boolean {
	return isOneOfVariant(order.orderType, ['limit', 'triggerLimit']);
}
