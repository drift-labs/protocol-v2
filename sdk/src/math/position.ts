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
import { OraclePriceData } from '../oracles/types';
import { PerpMarketAccount, PositionDirection, PerpPosition } from '../types';
import {
	calculateUpdatedAMM,
	calculateUpdatedAMMSpreadReserves,
	calculateAmmReservesAfterSwap,
	getSwapDirection,
} from './amm';

import { calculateBaseAssetValueWithOracle } from './margin';

/**
 * calculateBaseAssetValue
 * = market value of closing entire position
 * @param market
 * @param userPosition
 * @param oraclePriceData
 * @returns Base Asset Value. : Precision QUOTE_PRECISION
 */
export function calculateBaseAssetValue(
	market: PerpMarketAccount,
	userPosition: PerpPosition,
	oraclePriceData: OraclePriceData
): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	const directionToClose = findDirectionToClose(userPosition);
	let prepegAmm: Parameters<typeof calculateAmmReservesAfterSwap>[0];

	if (market.amm.baseSpread > 0) {
		const { baseAssetReserve, quoteAssetReserve, sqrtK, newPeg } =
			calculateUpdatedAMMSpreadReserves(
				market.amm,
				directionToClose,
				oraclePriceData
			);
		prepegAmm = {
			baseAssetReserve,
			quoteAssetReserve,
			sqrtK: sqrtK,
			pegMultiplier: newPeg,
		};
	} else {
		prepegAmm = calculateUpdatedAMM(market.amm, oraclePriceData);
	}

	const [newQuoteAssetReserve, _] = calculateAmmReservesAfterSwap(
		prepegAmm,
		'base',
		userPosition.baseAssetAmount.abs(),
		getSwapDirection('base', directionToClose)
	);

	switch (directionToClose) {
		case PositionDirection.SHORT:
			return prepegAmm.quoteAssetReserve
				.sub(newQuoteAssetReserve)
				.mul(prepegAmm.pegMultiplier)
				.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

		case PositionDirection.LONG:
			return newQuoteAssetReserve
				.sub(prepegAmm.quoteAssetReserve)
				.mul(prepegAmm.pegMultiplier)
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
 * @param oraclePriceData
 * @returns BaseAssetAmount : Precision QUOTE_PRECISION
 */
export function calculatePositionPNL(
	market: PerpMarketAccount,
	marketPosition: PerpPosition,
	withFunding = false,
	oraclePriceData: OraclePriceData
): BN {
	if (marketPosition.baseAssetAmount.eq(ZERO)) {
		return marketPosition.quoteAssetAmount;
	}

	const baseAssetValue = calculateBaseAssetValueWithOracle(
		market,
		marketPosition,
		oraclePriceData
	);

	const baseAssetValueSign = marketPosition.baseAssetAmount.isNeg()
		? new BN(-1)
		: new BN(1);
	let pnl = baseAssetValue
		.mul(baseAssetValueSign)
		.add(marketPosition.quoteAssetAmount);

	if (withFunding) {
		const fundingRatePnL = calculatePositionFundingPNL(
			market,
			marketPosition
		).div(PRICE_TO_QUOTE_PRECISION);

		pnl = pnl.add(fundingRatePnL);
	}

	return pnl;
}

export function calculateUnsettledPnl(
	market: PerpMarketAccount,
	marketPosition: PerpPosition,
	oraclePriceData: OraclePriceData
): BN {
	const unrealizedPnl = calculatePositionPNL(
		market,
		marketPosition,
		true,
		oraclePriceData
	);

	let unsettledPnl = unrealizedPnl;
	if (unrealizedPnl.gt(ZERO)) {
		const fundingPnL = calculatePositionFundingPNL(market, marketPosition).div(
			PRICE_TO_QUOTE_PRECISION
		);

		const maxPositivePnl = BN.max(
			marketPosition.quoteAssetAmount
				.sub(marketPosition.quoteEntryAmount)
				.add(fundingPnL),
			ZERO
		);

		unsettledPnl = BN.min(maxPositivePnl, unrealizedPnl);
	}
	return unsettledPnl;
}

/**
 *
 * @param market
 * @param marketPosition
 * @returns // TODO-PRECISION
 */
export function calculatePositionFundingPNL(
	market: PerpMarketAccount,
	marketPosition: PerpPosition
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

export function positionIsAvailable(position: PerpPosition): boolean {
	return (
		position.baseAssetAmount.eq(ZERO) &&
		position.openOrders.eq(ZERO) &&
		position.quoteAssetAmount.eq(ZERO) &&
		position.lpShares.eq(ZERO)
	);
}

/**
 *
 * @param userPosition
 * @returns Precision: MARK_PRICE_PRECISION (10^10)
 */
export function calculateEntryPrice(userPosition: PerpPosition): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	return userPosition.quoteEntryAmount
		.mul(MARK_PRICE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(userPosition.baseAssetAmount)
		.abs();
}

/**
 *
 * @param userPosition
 * @returns Precision: MARK_PRICE_PRECISION (10^10)
 */
export function calculateCostBasis(userPosition: PerpPosition): BN {
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
	userPosition: PerpPosition
): PositionDirection {
	return userPosition.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;
}

export function positionCurrentDirection(
	userPosition: PerpPosition
): PositionDirection {
	return userPosition.baseAssetAmount.gte(ZERO)
		? PositionDirection.LONG
		: PositionDirection.SHORT;
}

export function isEmptyPosition(userPosition: PerpPosition): boolean {
	return (
		userPosition.baseAssetAmount.eq(ZERO) && userPosition.openOrders.eq(ZERO)
	);
}
