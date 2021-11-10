import { Market, PositionDirection, UserPosition } from '../types';
import {
	AMM_TO_QUOTE_PRECISION_RATIO,
	PEG_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import BN from 'bn.js';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './amm';
import {
	AMM_RESERVE_PRECISION,
	FUNDING_PAYMENT_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
} from '../constants/numericConstants';

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

	const directionToClose = userPosition.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

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
				.div(PEG_PRECISION)
				.div(AMM_TO_QUOTE_PRECISION_RATIO);

		case PositionDirection.LONG:
			return newQuoteAssetReserve
				.sub(market.amm.quoteAssetReserve)
				.mul(market.amm.pegMultiplier)
				.div(PEG_PRECISION)
				.div(AMM_TO_QUOTE_PRECISION_RATIO);
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

	const directionToClose = marketPosition.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const baseAssetValue = calculateBaseAssetValue(market, marketPosition);
	let pnlAssetAmount;

	switch (directionToClose) {
		case PositionDirection.SHORT:
			pnlAssetAmount = baseAssetValue.sub(marketPosition.quoteAssetAmount);
			break;

		case PositionDirection.LONG:
			pnlAssetAmount = marketPosition.quoteAssetAmount.sub(baseAssetValue);
			break;
	}

	if (withFunding) {
		const fundingRatePnL = calculatePositionFundingPNL(
			market,
			marketPosition
		).div(PRICE_TO_QUOTE_PRECISION);

		pnlAssetAmount = pnlAssetAmount.add(fundingRatePnL);
	}

	return pnlAssetAmount;
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
