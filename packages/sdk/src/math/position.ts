import { BN } from '../isomorphic/anchor';
import {
	AMM_RESERVE_PRECISION,
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	AMM_TO_QUOTE_PRECISION_RATIO,
	FUNDING_RATE_BUFFER_PRECISION,
	PRICE_PRECISION,
	ONE,
	ZERO,
} from '../constants/numericConstants';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import {
	PerpMarketAccount,
	PositionDirection,
	PerpPosition,
	SpotMarketAccount,
	PositionFlag,
} from '../types';
import {
	calculateUpdatedAMM,
	calculateUpdatedAMMSpreadReserves,
	calculateAmmReservesAfterSwap,
	getSwapDirection,
} from './amm';
import { calculateBaseAssetValueWithOracle } from './margin';
import { calculateNetUserPnlImbalance } from './market';

/**
 * Simulates fully closing `userPosition` against the AMM (optionally through its bid/ask
 * spread reserves) and returns the resulting quote value — i.e. the market value of closing
 * the entire position right now, distinct from `calculateBaseAssetValueWithOracle`'s
 * mark-to-oracle valuation used for margin.
 * @param market Perp market whose AMM is used to price the close.
 * @param userPosition Position to value; returns zero if flat (`baseAssetAmount == 0`).
 * @param mmOraclePriceData MM oracle price data used to re-peg/update the AMM before pricing (unless `skipUpdate`).
 * @param useSpread If true (default) and the market has a nonzero base spread, price through the bid/ask spread reserves on the closing side rather than the raw AMM reserves.
 * @param skipUpdate If true, price against `market.amm` as-is without applying `calculateUpdatedAMM`/spread-reserve updates first (default false).
 * @param latestSlot Current slot, forwarded to the spread-reserve update for reference-price-offset smoothing.
 * @returns Value of fully closing the position, QUOTE_PRECISION (1e6).
 */
export function calculateBaseAssetValue(
	market: PerpMarketAccount,
	userPosition: PerpPosition,
	mmOraclePriceData: MMOraclePriceData,
	useSpread = true,
	skipUpdate = false,
	latestSlot?: BN
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
					market.marketStats,
					directionToClose,
					mmOraclePriceData,
					latestSlot
				);
			prepegAmm = {
				baseAssetReserve,
				quoteAssetReserve,
				sqrtK: sqrtK,
				pegMultiplier: newPeg,
			};
		} else {
			prepegAmm = calculateUpdatedAMM(market.amm, mmOraclePriceData);
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

		default:
			throw new Error('Invalid position direction to close');
	}
}

/**
 * Calculates a position's unrealized pnl, marked to the oracle price (via
 * `calculateBaseAssetValueWithOracle`) rather than the AMM close price. For a flat position
 * this is simply `quoteAssetAmount` (any residual realized/settled pnl still on the position).
 * @param market Perp market the position belongs to.
 * @param perpPosition Position to value.
 * @param withFunding If true, adds unsettled funding pnl (`calculateUnsettledFundingPnl`) to the result (default false).
 * @param oraclePriceData Must provide `price`, PRICE_PRECISION (1e6); used unless the market is in `settlement` status (which uses `market.expiryPrice` internally).
 * @returns Unrealized pnl, QUOTE_PRECISION (1e6, signed).
 */
export function calculatePositionPNL(
	market: PerpMarketAccount,
	perpPosition: PerpPosition,
	withFunding = false,
	oraclePriceData: Pick<OraclePriceData, 'price'>
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

/**
 * Caps a position's unrealized pnl (incl. funding) to the amount actually settleable via
 * `settle_pnl`, mirroring `PerpPosition::get_claimable_pnl` in
 * `programs/velocity/src/state/user.rs`. Positive pnl can only be settled up to whichever is
 * larger: pnl already realized by reducing the position (`quoteAssetAmount -
 * quoteEntryAmount`, floored at zero) plus any pnl-pool surplus over the market's net user
 * pnl (`calculateNetUserPnlImbalance`, negated and floored at zero). Negative pnl passes
 * through uncapped — this function does not itself gate on margin requirements (the program
 * separately blocks settling negative pnl for a user who wouldn't meet maintenance margin
 * afterward).
 * @param market Perp market the position belongs to.
 * @param spotMarket Quote spot market, used to size the pnl pool via `calculateNetUserPnlImbalance`.
 * @param perpPosition Position to evaluate.
 * @param oraclePriceData Must provide `price`, PRICE_PRECISION (1e6).
 * @returns Settleable pnl, QUOTE_PRECISION (1e6, signed) — equal to unrealized pnl if negative or uncapped, otherwise capped.
 */
export function calculateClaimablePnl(
	market: PerpMarketAccount,
	spotMarket: SpotMarketAccount,
	perpPosition: PerpPosition,
	oraclePriceData: Pick<OraclePriceData, 'price'>
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
 * Returns the cumulative fees-plus-funding component of a position's pnl (i.e. the part of
 * pnl not explained by price movement): settled funding/fees so far
 * (`quoteBreakEvenAmount - quoteEntryAmount`) plus, optionally, unsettled funding accrued
 * since the last funding settlement.
 * @param market Perp market the position belongs to.
 * @param perpPosition Position to evaluate.
 * @param includeUnsettled If true (default), adds `calculateUnsettledFundingPnl` to the result.
 * @returns Fees + funding pnl, QUOTE_PRECISION (1e6, signed).
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
 * Returns unsettled funding pnl accrued on the position since its last funding settlement:
 * the delta between the market's current cumulative funding rate (long or short side,
 * selected by position direction) and the position's `lastCumulativeFundingRate`, applied to
 * `baseAssetAmount`. Zero for a flat position.
 *
 * To calculate all fees and funding pnl including settled, use `calculateFeesAndFundingPnl`.
 *
 * @param market Perp market the position belongs to; uses `cumulativeFundingRateLong`/`cumulativeFundingRateShort`.
 * @param perpPosition Position to evaluate.
 * @returns Unsettled funding pnl, QUOTE_PRECISION (1e6, signed).
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
		ammCumulativeFundingRate = market.cumulativeFundingRateLong;
	} else {
		ammCumulativeFundingRate = market.cumulativeFundingRateShort;
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
 * True if a `PerpPosition` slot is free to be reused for a different market, mirroring
 * `PerpPosition::is_available` in `programs/velocity/src/state/user.rs`: no open base
 * position, no open orders, no unsettled quote pnl, no isolated-margin collateral parked in
 * it (`isolatedPositionScaledBalance == 0`), and not currently mid-liquidation/bankruptcy.
 * An isolated position with collateral still deposited is never "available" even if flat,
 * since that collateral must be withdrawn first.
 * @param position Position slot to check.
 * @returns `true` if the slot can be assigned to a new market.
 */
export function positionIsAvailable(position: PerpPosition): boolean {
	return (
		position.baseAssetAmount.eq(ZERO) &&
		position.openOrders === 0 &&
		position.quoteAssetAmount.eq(ZERO) &&
		position.isolatedPositionScaledBalance.eq(ZERO) &&
		!positionIsBeingLiquidated(position)
	);
}

/** True if `position.positionFlag` has the `BeingLiquidated` or `Bankruptcy` bit set. */
export function positionIsBeingLiquidated(position: PerpPosition): boolean {
	return (
		(position.positionFlag &
			(PositionFlag.BeingLiquidated | PositionFlag.Bankruptcy)) >
		0
	);
}

/**
 * Price at which closing the position realizes zero further pnl, i.e. entry price adjusted
 * for fees and funding paid/received so far (`quoteBreakEvenAmount / baseAssetAmount`).
 * @param userPosition Position to evaluate.
 * @returns Break-even price (always non-negative), PRICE_PRECISION (1e6). Zero if flat.
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
 * Average entry price of the position, before fees/funding (`quoteEntryAmount / baseAssetAmount`).
 * @param userPosition Position to evaluate.
 * @returns Average entry price (always non-negative), PRICE_PRECISION (1e6). Zero if flat.
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
 * Cost basis of the position (`quoteAssetAmount / baseAssetAmount`, optionally including
 * realized settled pnl), i.e. the current quote value backing the position expressed per
 * unit of base — this differs from `calculateEntryPrice` whenever the position has
 * accumulated settled pnl or fees since it was opened.
 * @param userPosition Position to evaluate.
 * @param includeSettledPnl If true, folds `userPosition.settledPnl` into the quote amount before dividing (default false).
 * @returns Cost basis (always non-negative), PRICE_PRECISION (1e6). Zero if flat.
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

/** Direction of the trade that would fully close `userPosition`: `SHORT` for a long position (base > 0), `LONG` otherwise (including flat). */
export function findDirectionToClose(
	userPosition: PerpPosition
): PositionDirection {
	return userPosition.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;
}

/** The position's own directional exposure: `LONG` if `baseAssetAmount >= 0` (including flat), `SHORT` if negative. */
export function positionCurrentDirection(
	userPosition: PerpPosition
): PositionDirection {
	return userPosition.baseAssetAmount.gte(ZERO)
		? PositionDirection.LONG
		: PositionDirection.SHORT;
}

/** True if the position has no open base exposure and no open orders (a coarser check than `positionIsAvailable` — does not check quote pnl, isolated collateral, or liquidation flags). */
export function isEmptyPosition(userPosition: PerpPosition): boolean {
	return userPosition.baseAssetAmount.eq(ZERO) && userPosition.openOrders === 0;
}

/** True if the position has any open orders, resting bids, or resting asks, mirroring `PerpPosition::has_open_order` in `programs/velocity/src/state/user.rs`. */
export function hasOpenOrders(position: PerpPosition): boolean {
	return (
		position.openOrders != 0 ||
		!position.openBids.eq(ZERO) ||
		!position.openAsks.eq(ZERO)
	);
}
