import { isVariant, MarketAccount, Order, PositionDirection } from './types';
import { BN, standardizeBaseAssetAmount } from '.';
import { ZERO } from './constants/numericConstants';
import { calculateMaxBaseAssetAmountToTrade } from './math/amm';
import { OraclePriceData } from '.';

export function calculateBaseAssetAmountMarketCanExecute(
	market: MarketAccount,
	order: Order,
	oraclePriceData?: OraclePriceData
): BN {
	if (isVariant(order.orderType, 'limit')) {
		return calculateAmountToTradeForLimit(market, order, oraclePriceData);
	} else if (isVariant(order.orderType, 'triggerLimit')) {
		return calculateAmountToTradeForTriggerLimit(market, order);
	} else if (isVariant(order.orderType, 'market')) {
		return ZERO;
	} else {
		return calculateAmountToTradeForTriggerMarket(market, order);
	}
}

export function calculateAmountToTradeForLimit(
	market: MarketAccount,
	order: Order,
	oraclePriceData?: OraclePriceData
): BN {
	let limitPrice = order.price;
	if (!order.oraclePriceOffset.eq(ZERO)) {
		if (!oraclePriceData) {
			throw Error(
				'Cant calculate limit price for oracle offset oracle without OraclePriceData'
			);
		}
		limitPrice = oraclePriceData.price.add(order.oraclePriceOffset);
	}

	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		market.amm,
		limitPrice,
		order.direction,
		oraclePriceData
	);

	const baseAssetAmount = standardizeBaseAssetAmount(
		maxAmountToTrade,
		market.amm.baseAssetAmountStepSize
	);

	// Check that directions are the same
	const sameDirection = isSameDirection(direction, order.direction);
	if (!sameDirection) {
		return ZERO;
	}

	return baseAssetAmount.gt(order.baseAssetAmount)
		? order.baseAssetAmount
		: baseAssetAmount;
}

export function calculateAmountToTradeForTriggerLimit(
	market: MarketAccount,
	order: Order
): BN {
	if (!order.triggered) {
		return ZERO;
	}

	return calculateAmountToTradeForLimit(market, order);
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

function calculateAmountToTradeForTriggerMarket(
	market: MarketAccount,
	order: Order
): BN {
	if (!order.triggered) {
		return ZERO;
	}

	return order.baseAssetAmount;
}
