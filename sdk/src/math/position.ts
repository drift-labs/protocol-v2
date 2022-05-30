import { BN } from '../';
import {
	AMM_RESERVE_PRECISION,
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	AMM_TO_QUOTE_PRECISION_RATIO,
	FUNDING_PAYMENT_PRECISION,
	MARK_PRICE_PRECISION,
	ONE,
	PRICE_TO_QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { Market, PositionDirection, UserPosition } from '../types';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './amm';

/**
 * calculateBaseAssetValue
 * = market value of closing entire position
 * @param market
 * @param userPosition
 * @returns Base Asset Value. : Precision QUOTE_PRECISION
 */
export function calculateBaseAssetValue(
	market: Market,
	userPosition: UserPosition
): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	const directionToClose = findDirectionToClose(userPosition);

	const [newQuoteAssetReserve, _] = calculateAmmReservesAfterSwap(
		market.amm,
		'base',
		userPosition.baseAssetAmount.abs(),
		getSwapDirection('base', directionToClose)
	);

	switch (directionToClose) {
		case PositionDirection.SHORT:
			return market.amm.quoteAssetReserve
				.sub(newQuoteAssetReserve)
				.mul(market.amm.pegMultiplier)
				.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

		case PositionDirection.LONG:
			return newQuoteAssetReserve
				.sub(market.amm.quoteAssetReserve)
				.mul(market.amm.pegMultiplier)
				.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
				.add(ONE);
	}
}

/**
 * calculatePositionPNL
 * = BaseAssetAmount * (Avg Exit Price - Avg Entry Price)
 * @param market
 * @param marketPosition
 * @param withFunding (adds unrealized funding payment pnl to result)
 * @returns BaseAssetAmount : Precision QUOTE_PRECISION
 */
export function calculatePositionPNL(
	market: Market,
	marketPosition: UserPosition,
	withFunding = false
): BN {
	if (marketPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	const baseAssetValue = calculateBaseAssetValue(market, marketPosition);

	let pnl;
	if (marketPosition.baseAssetAmount.gt(ZERO)) {
		pnl = baseAssetValue.sub(marketPosition.quoteAssetAmount);
	} else {
		pnl = marketPosition.quoteAssetAmount.sub(baseAssetValue);
	}

	if (withFunding) {
		const fundingRatePnL = calculatePositionFundingPNL(
			market,
			marketPosition
		).div(PRICE_TO_QUOTE_PRECISION);

		pnl = pnl.add(fundingRatePnL);
	}

	return pnl;
}

/**
 *
 * @param market
 * @param marketPosition
 * @returns // TODO-PRECISION
 */
export function calculatePositionFundingPNL(
	market: Market,
	marketPosition: UserPosition
): BN {
	if (marketPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	let ammCumulativeFundingRate: BN;
	if (marketPosition.baseAssetAmount.gt(ZERO)) {
		ammCumulativeFundingRate = market.amm.cumulativeFundingRateLong;
	} else {
		ammCumulativeFundingRate = market.amm.cumulativeFundingRateShort;
	}

	const perPositionFundingRate = ammCumulativeFundingRate
		.sub(marketPosition.lastCumulativeFundingRate)
		.mul(marketPosition.baseAssetAmount)
		.div(AMM_RESERVE_PRECISION)
		.div(FUNDING_PAYMENT_PRECISION)
		.mul(new BN(-1));

	return perPositionFundingRate;
}

/**
 *
 * @param userPosition
 * @returns Precision: MARK_PRICE_PRECISION (10^10)
 */
export function calculateEntryPrice(userPosition: UserPosition): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	return userPosition.quoteAssetAmount
		.mul(MARK_PRICE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(userPosition.baseAssetAmount)
		.abs();
}

export function findDirectionToClose(
	userPosition: UserPosition
): PositionDirection {
	return userPosition.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;
}

export function positionCurrentDirection(
	userPosition: UserPosition
): PositionDirection {
	return userPosition.baseAssetAmount.gte(ZERO)
		? PositionDirection.LONG
		: PositionDirection.SHORT;
}

export function isEmptyPosition(userPosition: UserPosition): boolean {
	return (
		userPosition.baseAssetAmount.eq(ZERO) && userPosition.openOrders.eq(ZERO)
	);
}
