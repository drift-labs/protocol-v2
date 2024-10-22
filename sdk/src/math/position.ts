import { BN, SpotMarketAccount } from '../';
import {
	AMM_RESERVE_PRECISION,
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	AMM_TO_QUOTE_PRECISION_RATIO,
	FUNDING_RATE_BUFFER_PRECISION,
	PRICE_PRECISION,
	ONE,
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
import { calculateNetUserPnlImbalance } from './market';

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
	oraclePriceData: OraclePriceData,
	useSpread = true,
	skipUpdate = false
): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	const directionToClose = findDirectionToClose(userPosition);
	let prepegAmm: Parameters<typeof calculateAmmReservesAfterSwap>[0];

	if (!skipUpdate) {
		if (market.amm.baseSpread > 0 && useSpread) {
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
	} else {
		prepegAmm = market.amm;
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
 * @param PerpPosition
 * @param withFunding (adds unrealized funding payment pnl to result)
 * @param oraclePriceData
 * @returns BaseAssetAmount : Precision QUOTE_PRECISION
 */
export function calculatePositionPNL(
	market: PerpMarketAccount,
	perpPosition: PerpPosition,
	withFunding = false,
	oraclePriceData: OraclePriceData
): BN {
	if (perpPosition.baseAssetAmount.eq(ZERO)) {
		return perpPosition.quoteAssetAmount;
	}

	const baseAssetValue = calculateBaseAssetValueWithOracle(
		market,
		perpPosition,
		oraclePriceData
	);

	const baseAssetValueSign = perpPosition.baseAssetAmount.isNeg()
		? new BN(-1)
		: new BN(1);
	let pnl = baseAssetValue
		.mul(baseAssetValueSign)
		.add(perpPosition.quoteAssetAmount);

	if (withFunding) {
		const fundingRatePnL = calculateUnsettledFundingPnl(market, perpPosition);

		pnl = pnl.add(fundingRatePnL);
	}

	return pnl;
}

export function calculateClaimablePnl(
	market: PerpMarketAccount,
	spotMarket: SpotMarketAccount,
	perpPosition: PerpPosition,
	oraclePriceData: OraclePriceData
): BN {
	const unrealizedPnl = calculatePositionPNL(
		market,
		perpPosition,
		true,
		oraclePriceData
	);

	let unsettledPnl = unrealizedPnl;
	if (unrealizedPnl.gt(ZERO)) {
		const excessPnlPool = BN.max(
			ZERO,
			calculateNetUserPnlImbalance(market, spotMarket, oraclePriceData).mul(
				new BN(-1)
			)
		);

		const maxPositivePnl = BN.max(
			perpPosition.quoteAssetAmount.sub(perpPosition.quoteEntryAmount),
			ZERO
		).add(excessPnlPool);

		unsettledPnl = BN.min(maxPositivePnl, unrealizedPnl);
	}
	return unsettledPnl;
}

/**
 * Returns total fees and funding pnl for a position
 *
 * @param market
 * @param PerpPosition
 * @param includeUnsettled include unsettled funding in return value (default: true)
 * @returns — // QUOTE_PRECISION
 */
export function calculateFeesAndFundingPnl(
	market: PerpMarketAccount,
	perpPosition: PerpPosition,
	includeUnsettled = true
): BN {
	const settledFundingAndFeesPnl = perpPosition.quoteBreakEvenAmount.sub(
		perpPosition.quoteEntryAmount
	);

	if (!includeUnsettled) {
		return settledFundingAndFeesPnl;
	}

	const unsettledFundingPnl = calculateUnsettledFundingPnl(
		market,
		perpPosition
	);

	return settledFundingAndFeesPnl.add(unsettledFundingPnl);
}

/**
 * Returns unsettled funding pnl for the position
 *
 * To calculate all fees and funding pnl including settled, use calculateFeesAndFundingPnl
 *
 * @param market
 * @param PerpPosition
 * @returns // QUOTE_PRECISION
 */
export function calculateUnsettledFundingPnl(
	market: PerpMarketAccount,
	perpPosition: PerpPosition
): BN {
	if (perpPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	let ammCumulativeFundingRate: BN;
	if (perpPosition.baseAssetAmount.gt(ZERO)) {
		ammCumulativeFundingRate = market.amm.cumulativeFundingRateLong;
	} else {
		ammCumulativeFundingRate = market.amm.cumulativeFundingRateShort;
	}

	const perPositionFundingRate = ammCumulativeFundingRate
		.sub(perpPosition.lastCumulativeFundingRate)
		.mul(perpPosition.baseAssetAmount)
		.div(AMM_RESERVE_PRECISION)
		.div(FUNDING_RATE_BUFFER_PRECISION)
		.mul(new BN(-1));

	return perPositionFundingRate;
}

/**
 * @deprecated use calculateUnsettledFundingPnl or calculateFeesAndFundingPnl instead
 */
export function calculatePositionFundingPNL(
	market: PerpMarketAccount,
	perpPosition: PerpPosition
): BN {
	return calculateUnsettledFundingPnl(market, perpPosition);
}

export function positionIsAvailable(position: PerpPosition): boolean {
	return (
		position.baseAssetAmount.eq(ZERO) &&
		position.openOrders === 0 &&
		position.quoteAssetAmount.eq(ZERO) &&
		position.lpShares.eq(ZERO)
	);
}

/**
 *
 * @param userPosition
 * @returns Precision: PRICE_PRECISION (10^6)
 */
export function calculateBreakEvenPrice(userPosition: PerpPosition): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	return userPosition.quoteBreakEvenAmount
		.mul(PRICE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(userPosition.baseAssetAmount)
		.abs();
}

/**
 *
 * @param userPosition
 * @returns Precision: PRICE_PRECISION (10^6)
 */
export function calculateEntryPrice(userPosition: PerpPosition): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	return userPosition.quoteEntryAmount
		.mul(PRICE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO)
		.div(userPosition.baseAssetAmount)
		.abs();
}

/**
 *
 * @param userPosition
 * @returns Precision: PRICE_PRECISION (10^10)
 */
export function calculateCostBasis(
	userPosition: PerpPosition,
	includeSettledPnl = false
): BN {
	if (userPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	return userPosition.quoteAssetAmount
		.add(includeSettledPnl ? userPosition.settledPnl : ZERO)
		.mul(PRICE_PRECISION)
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
	return userPosition.baseAssetAmount.eq(ZERO) && userPosition.openOrders === 0;
}

export function hasOpenOrders(position: PerpPosition): boolean {
	return (
		position.openOrders != 0 ||
		!position.openBids.eq(ZERO) ||
		!position.openAsks.eq(ZERO)
	);
}
