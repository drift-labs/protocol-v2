import { ClearingHouseUser } from '../clearingHouseUser';
import { isOneOfVariant, isVariant, MarketAccount, Order } from '../types';
import { ZERO, TWO } from '../constants/numericConstants';
import { BN } from '@project-serum/anchor';
import { OraclePriceData } from '../oracles/types';
import { getAuctionPrice, isAuctionComplete } from './auction';
import { calculateAskPrice, calculateBidPrice } from './market';

export function isOrderRiskIncreasing(
	user: ClearingHouseUser,
	order: Order
): boolean {
	if (isVariant(order.status, 'init')) {
		return false;
	}

	const position =
		user.getUserPosition(order.marketIndex) ||
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
	user: ClearingHouseUser,
	order: Order
): boolean {
	if (isVariant(order.status, 'init')) {
		return false;
	}

	const position =
		user.getUserPosition(order.marketIndex) ||
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

export function isOrderReduceOnly(
	user: ClearingHouseUser,
	order: Order
): boolean {
	if (isVariant(order.status, 'init')) {
		return false;
	}

	const position =
		user.getUserPosition(order.marketIndex) ||
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
	market: MarketAccount,
	oraclePriceData: OraclePriceData,
	slot: number
): BN {
	let limitPrice;
	if (!order.oraclePriceOffset.eq(ZERO)) {
		limitPrice = oraclePriceData.price.add(order.oraclePriceOffset);
	} else if (isOneOfVariant(order.orderType, ['market', 'triggerMarket'])) {
		if (isAuctionComplete(order, slot)) {
			limitPrice = getAuctionPrice(order, slot);
		} else if (!order.price.eq(ZERO)) {
			limitPrice = order.price;
		} else if (isVariant(order.direction, 'long')) {
			const askPrice = calculateAskPrice(market, oraclePriceData);
			const delta = askPrice.div(new BN(market.amm.maxSlippageRatio));
			limitPrice = askPrice.add(delta);
		} else {
			const bidPrice = calculateBidPrice(market, oraclePriceData);
			const delta = bidPrice.div(new BN(market.amm.maxSlippageRatio));
			limitPrice = bidPrice.sub(delta);
		}
	} else {
		limitPrice = order.price;
	}

	return limitPrice;
}
