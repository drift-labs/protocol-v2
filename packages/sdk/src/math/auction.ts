import {
	isOneOfVariant,
	isVariant,
	OracleValidity,
	Order,
	PerpOperation,
	PositionDirection,
	StateAccount,
} from '../types';
import { BN } from '../isomorphic/anchor';
import {
	ONE,
	ZERO,
	QUOTE_PRECISION,
	PRICE_PRECISION,
} from '../constants/numericConstants';
import { getVariant, OrderBitFlag, PerpMarketAccount } from '../types';
import { getPerpMarketTierNumber } from './tiers';
import { MMOraclePriceData } from '../oracles/types';
import { isLowRiskForAmm, standardizePrice } from './orders';
import { getOracleValidity } from './oracles';
import { isAmmDrawdownPause, isOperationPaused } from './exchangeStatus';

/** True if `order`'s auction has run its full `auctionDuration` (in slots) as of `slot`, or the order has no auction (`auctionDuration === 0`). */
export function isAuctionComplete(order: Order, slot: number): boolean {
	if (order.auctionDuration === 0) {
		return true;
	}

	return new BN(slot).sub(order.slot).gt(new BN(order.auctionDuration));
}

/**
 * True if the AMM is currently a permitted fallback liquidity source for `order`, mirroring the
 * program's `amm_fill_gates_ok` (`state/perp_market.rs`) — the hard gates that suppress all AMM
 * fills (standalone and JIT), not the auction-timing gates JIT bypasses, and not price/size (see
 * `calculateBaseAssetAmountForAmmToFulfill` for that). Blocked if `AMM_FILL` is paused, if the
 * market has too much drawdown, if the MM oracle is too volatile vs the exchange oracle (enabled +
 * as-recent + >1% price diff — early volatility protection), or if the MM-oracle validity is
 * `StaleForAMMLowRisk` or worse. If validity is exactly `Valid`, always allowed; otherwise (a
 * degraded-but-not-stale oracle) only allowed when the order itself is low-risk for the AMM
 * (`isLowRiskForAmm`) — e.g. it predates the oracle delay, is part of a liquidation, or carries
 * the safe-trigger flag.
 * @param order Order to check.
 * @param mmOraclePriceData Current MM oracle price data — the MM-volatility gate reads its
 *   `isMMOracleEnabled`/`isMMOracleAsRecent`/`isMMExchangeDiffBpsHigh` flags (populated by
 *   `VelocityClient.getMMOracleDataForPerpMarket`); when those are absent the gate is skipped.
 * @param slot Current slot.
 * @param state Global state, providing oracle guard rails.
 * @param market Perp market the order is on.
 * @param isLiquidation Whether the fill is part of a liquidation (relaxes the low-risk check).
 * @returns `true` if the AMM may currently act as a fallback liquidity source for this order.
 */
export function isFallbackAvailableLiquiditySource(
	order: Order,
	mmOraclePriceData: MMOraclePriceData,
	slot: number,
	state: StateAccount,
	market: PerpMarketAccount,
	isLiquidation?: boolean
): boolean {
	if (isOperationPaused(market.pausedOperations, PerpOperation.AMM_FILL)) {
		return false;
	}

	if (isAmmDrawdownPause(market)) {
		return false;
	}

	// MM-oracle volatility gate (M15): mirrors `amm_fill_gates_ok`'s
	// `mm_oracle_not_too_volatile`. We already use safe MM oracle data, but the AMM isn't
	// available if we *could* have used the MM oracle yet fell back due to a >1% price diff —
	// early volatility protection. Only applies when the MM oracle is enabled and at least as
	// recent as the exchange oracle; skipped when those flags weren't populated.
	if (
		mmOraclePriceData.isMMOracleEnabled &&
		mmOraclePriceData.isMMOracleAsRecent &&
		mmOraclePriceData.isMMExchangeDiffBpsHigh
	) {
		return false;
	}

	const oracleValidity = getOracleValidity(
		market!,
		{
			price: mmOraclePriceData.price,
			slot: mmOraclePriceData.slot,
			confidence: mmOraclePriceData.confidence,
			hasSufficientNumberOfDataPoints:
				mmOraclePriceData.hasSufficientNumberOfDataPoints,
		},
		state.oracleGuardRails,
		new BN(slot)
	);
	if (oracleValidity <= OracleValidity.StaleForAMMLowRisk) {
		return false;
	}

	if (oracleValidity == OracleValidity.Valid) {
		return true;
	}

	const isOrderLowRiskForAmm = isLowRiskForAmm(
		order,
		mmOraclePriceData,
		isLiquidation
	);

	if (!isOrderLowRiskForAmm) {
		return false;
	} else {
		return true;
	}
}

/**
 * Dispatches to the correct in-progress auction price for `order` based on its order type:
 * fixed-price auction (`getAuctionPriceForFixedAuction`) for market/triggerLimit/plain-limit
 * orders, or oracle-offset auction (`getAuctionPriceForOracleOffsetAuction`) for
 * oracle-pegged limit/oracle/oracle-triggered-market orders. The result is always
 * standardized to `tickSize`.
 * @param order Order whose auction price to compute.
 * @param slot Current slot.
 * @param oraclePrice Use `MMOraclePriceData` source for perp orders, `OraclePriceData` for spot; PRICE_PRECISION (1e6).
 * @param tickSize Market's order tick size, PRICE_PRECISION (1e6). Defaults to `ONE` (no effective standardization).
 * @returns Auction price at the current slot, PRICE_PRECISION (1e6).
 * @throws if `order.orderType` doesn't match any known auction pricing path.
 */
export function getAuctionPrice(
	order: Order,
	slot: number,
	oraclePrice: BN,
	tickSize: BN = ONE
): BN {
	if (
		isOneOfVariant(order.orderType, ['market', 'triggerLimit']) ||
		(isVariant(order.orderType, 'triggerMarket') &&
			(order.bitFlags & OrderBitFlag.OracleTriggerMarket) === 0)
	) {
		return getAuctionPriceForFixedAuction(order, slot, tickSize);
	} else if (isVariant(order.orderType, 'limit')) {
		if (order.oraclePriceOffset != null && !order.oraclePriceOffset.eq(ZERO)) {
			return getAuctionPriceForOracleOffsetAuction(
				order,
				slot,
				oraclePrice,
				tickSize
			);
		} else {
			return getAuctionPriceForFixedAuction(order, slot, tickSize);
		}
	} else if (
		isVariant(order.orderType, 'oracle') ||
		(isVariant(order.orderType, 'triggerMarket') &&
			(order.bitFlags & OrderBitFlag.OracleTriggerMarket) !== 0)
	) {
		return getAuctionPriceForOracleOffsetAuction(
			order,
			slot,
			oraclePrice,
			tickSize
		);
	} else {
		throw Error(
			`Cant get auction price for order type ${getVariant(order.orderType)}`
		);
	}
}

/**
 * Linearly interpolates between `order.auctionStartPrice` and `order.auctionEndPrice` based
 * on slots elapsed out of `order.auctionDuration`, then standardizes the result to
 * `tickSize` in the order's favor (via `standardizePrice`) so every auction tick already
 * lines up with the market's tick size. Returns the (standardized) end price directly once
 * the auction is complete or has zero duration.
 * @param order Order whose fixed-price auction to evaluate.
 * @param slot Current slot.
 * @param tickSize Market's order tick size, PRICE_PRECISION (1e6). Defaults to `ONE` (no effective standardization).
 * @returns Auction price at the current slot, PRICE_PRECISION (1e6).
 */
export function getAuctionPriceForFixedAuction(
	order: Order,
	slot: number,
	tickSize: BN = ONE
): BN {
	const slotsElapsed = new BN(slot).sub(order.slot);

	const deltaDenominator = new BN(order.auctionDuration);
	const deltaNumerator = BN.min(slotsElapsed, deltaDenominator);

	if (deltaDenominator.eq(ZERO)) {
		return standardizePrice(order.auctionEndPrice, tickSize, order.direction);
	}

	let priceDelta;
	if (isVariant(order.direction, 'long')) {
		priceDelta = order.auctionEndPrice
			.sub(order.auctionStartPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	} else {
		priceDelta = order.auctionStartPrice
			.sub(order.auctionEndPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	}

	let price;
	if (isVariant(order.direction, 'long')) {
		price = order.auctionStartPrice.add(priceDelta);
	} else {
		price = order.auctionStartPrice.sub(priceDelta);
	}

	return standardizePrice(price, tickSize, order.direction);
}

/**
 * Linearly interpolates the oracle price offset between `order.auctionStartPrice` and
 * `order.auctionEndPrice` (both offsets from the oracle price, not absolute prices) based on
 * slots elapsed out of `order.auctionDuration`, adds it to the live `oraclePrice`, floors it
 * at `tickSize`, then standardizes the result to `tickSize` in the order's favor. Returns the
 * (standardized, floored) end-offset price directly once the auction is complete or has zero
 * duration.
 * @param order Order whose oracle-offset auction to evaluate.
 * @param slot Current slot.
 * @param oraclePrice Use `MMOraclePriceData` source for perp orders, `OraclePriceData` for spot; PRICE_PRECISION (1e6).
 * @param tickSize Market's order tick size, PRICE_PRECISION (1e6). Defaults to `ONE` (no effective standardization).
 * @returns Auction price at the current slot, PRICE_PRECISION (1e6).
 */
export function getAuctionPriceForOracleOffsetAuction(
	order: Order,
	slot: number,
	oraclePrice: BN,
	tickSize: BN = ONE
): BN {
	const slotsElapsed = new BN(slot).sub(order.slot);

	const deltaDenominator = new BN(order.auctionDuration);
	const deltaNumerator = BN.min(slotsElapsed, deltaDenominator);

	if (deltaDenominator.eq(ZERO)) {
		const price = BN.max(oraclePrice.add(order.auctionEndPrice), tickSize);
		return standardizePrice(price, tickSize, order.direction);
	}

	let priceOffsetDelta;
	if (isVariant(order.direction, 'long')) {
		priceOffsetDelta = order.auctionEndPrice
			.sub(order.auctionStartPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	} else {
		priceOffsetDelta = order.auctionStartPrice
			.sub(order.auctionEndPrice)
			.mul(deltaNumerator)
			.div(deltaDenominator);
	}

	let priceOffset;
	if (isVariant(order.direction, 'long')) {
		priceOffset = order.auctionStartPrice.add(priceOffsetDelta);
	} else {
		priceOffset = order.auctionStartPrice.sub(priceOffsetDelta);
	}

	const price = BN.max(oraclePrice.add(priceOffset), tickSize);
	return standardizePrice(price, tickSize, order.direction);
}

/**
 * Converts absolute auction start/end prices (and a desired limit price) into the
 * oracle-offset form the program expects for oracle-pegged orders: offsets from the current
 * oracle price rather than absolute prices. Derives `oraclePriceOffset` from `limitPrice -
 * oraclePrice` when both are nonzero, falling back to `auctionEndPrice - oraclePrice` (±1,
 * biased away from the oracle in the order's direction) otherwise. Optionally clamps the
 * absolute start/end prices to `auctionPriceCaps` before converting.
 * @param direction Order side; determines the ±1 bias when deriving a fallback offset.
 * @param oraclePrice Current oracle price, PRICE_PRECISION (1e6).
 * @param auctionStartPrice Desired absolute auction start price, PRICE_PRECISION (1e6).
 * @param auctionEndPrice Desired absolute auction end price, PRICE_PRECISION (1e6).
 * @param limitPrice Desired absolute limit price (0 to derive the offset purely from `auctionEndPrice`), PRICE_PRECISION (1e6).
 * @param auctionPriceCaps Optional `{ min, max }` bounds (PRICE_PRECISION 1e6) to clamp the absolute start/end prices to before converting to offsets.
 * @returns `auctionStartPrice`/`auctionEndPrice` as oracle offsets, and `oraclePriceOffset` for the limit price — all PRICE_PRECISION (1e6), relative to `oraclePrice`.
 */
export function deriveOracleAuctionParams({
	direction,
	oraclePrice,
	auctionStartPrice,
	auctionEndPrice,
	limitPrice,
	auctionPriceCaps,
}: {
	direction: PositionDirection;
	oraclePrice: BN;
	auctionStartPrice: BN;
	auctionEndPrice: BN;
	limitPrice: BN;
	auctionPriceCaps?: {
		min: BN;
		max: BN;
	};
}): { auctionStartPrice: BN; auctionEndPrice: BN; oraclePriceOffset: BN } {
	let oraclePriceOffset;

	if (limitPrice.eq(ZERO) || oraclePrice.eq(ZERO)) {
		oraclePriceOffset = ZERO;
	} else {
		oraclePriceOffset = limitPrice.sub(oraclePrice);
	}

	if (oraclePriceOffset.eq(ZERO)) {
		oraclePriceOffset = isVariant(direction, 'long')
			? auctionEndPrice.sub(oraclePrice).add(ONE)
			: auctionEndPrice.sub(oraclePrice).sub(ONE);
	}

	if (auctionPriceCaps) {
		auctionStartPrice = BN.min(
			BN.max(auctionStartPrice, auctionPriceCaps.min),
			auctionPriceCaps.max
		);
		auctionEndPrice = BN.min(
			BN.max(auctionEndPrice, auctionPriceCaps.min),
			auctionPriceCaps.max
		);
	}

	return {
		auctionStartPrice: auctionStartPrice.sub(oraclePrice),
		auctionEndPrice: auctionEndPrice.sub(oraclePrice),
		oraclePriceOffset: oraclePriceOffset,
	};
}

/**
 * Derives a reasonable auction start price for a newly-triggered trigger order, biasing off
 * the current oracle price by an offset estimated from recent mark/oracle spread (or, if
 * mark and oracle TWAPs have recently diverged or 24h volume is thin, a coarser
 * TWAP-fraction fallback scaled by contract tier). Applies a further directional "start
 * buffer" in bps (tighter for tier A/B markets) so the auction starts slightly aggressive,
 * then clamps to `limitPrice` if one is given so the auction never starts past the user's
 * limit.
 * @param params.perpMarket Market providing TWAP stats and contract tier.
 * @param params.direction Order side.
 * @param params.oraclePrice Current oracle price — use `OraclePriceData.price`, PRICE_PRECISION (1e6).
 * @param params.limitPrice Optional limit price to clamp the start price to, PRICE_PRECISION (1e6).
 * @returns Auction start price, PRICE_PRECISION (1e6).
 */
export function getTriggerAuctionStartPrice(params: {
	perpMarket: PerpMarketAccount;
	direction: PositionDirection;
	oraclePrice: BN;
	limitPrice?: BN;
}): BN {
	const { perpMarket, direction, oraclePrice, limitPrice } = params;

	const twapMismatch =
		perpMarket.marketStats.historicalOracleData.lastOraclePriceTwapTs
			.sub(perpMarket.marketStats.lastMarkPriceTwapTs)
			.abs()
			.gte(new BN(60)) ||
		perpMarket.marketStats.volume24H.lte(new BN(100_000).mul(QUOTE_PRECISION));

	let baselineStartOffset: BN;

	if (twapMismatch) {
		const contractTierNumber = getPerpMarketTierNumber(perpMarket);
		const priceDivisor = contractTierNumber <= 1 ? 500 : 100;
		baselineStartOffset = isVariant(direction, 'long')
			? perpMarket.marketStats.lastBidPriceTwap.divn(priceDivisor)
			: perpMarket.marketStats.lastAskPriceTwap.divn(priceDivisor).neg();
	} else {
		const markTwapSlow = isVariant(direction, 'long')
			? perpMarket.marketStats.lastBidPriceTwap
			: perpMarket.marketStats.lastAskPriceTwap;

		const markTwapFast = perpMarket.marketStats.lastMarkPriceTwap5Min;
		const oracleTwapSlow =
			perpMarket.marketStats.historicalOracleData.lastOraclePriceTwap;
		const oracleTwapFast =
			perpMarket.marketStats.historicalOracleData.lastOraclePriceTwap5Min;

		const offsetSlow = markTwapSlow.sub(oracleTwapSlow);
		const offsetFast = markTwapFast.sub(oracleTwapFast);

		// long_spread/short_spread were removed from AMM in the decoupling refactor.
		// Fall back to half base_spread as the per-side spread approximation; the
		// AMM no longer caches an exact per-side spread without oracle context.
		const halfBaseSpread = new BN(Math.floor(perpMarket.amm.baseSpread / 2));
		const fracOfLongSpreadInPrice = halfBaseSpread
			.mul(markTwapSlow)
			.div(PRICE_PRECISION.muln(10)); // divide by 10x for safety

		const fracOfShortSpreadInPrice = halfBaseSpread
			.mul(markTwapSlow)
			.div(PRICE_PRECISION.muln(10)); // divide by 10x for safety

		baselineStartOffset = isVariant(direction, 'long')
			? BN.min(
					offsetSlow.add(fracOfLongSpreadInPrice),
					offsetFast.sub(fracOfShortSpreadInPrice)
			  )
			: BN.max(
					offsetSlow.sub(fracOfShortSpreadInPrice),
					offsetFast.add(fracOfLongSpreadInPrice)
			  );
	}

	let startBuffer = -3500;

	if (
		isVariant(perpMarket.contractTier, 'a') ||
		isVariant(perpMarket.contractTier, 'b')
	) {
		startBuffer = -500;
	}

	// Apply start buffer (in BPS)
	const startBufferPrice = oraclePrice
		.mul(new BN(startBuffer))
		.div(new BN(PRICE_PRECISION));

	let auctionStartPrice = isVariant(direction, 'long')
		? oraclePrice.add(baselineStartOffset).sub(startBufferPrice)
		: oraclePrice.add(baselineStartOffset).add(startBufferPrice);

	if (limitPrice) {
		if (isVariant(direction, 'long')) {
			auctionStartPrice = BN.min(auctionStartPrice, limitPrice);
		} else {
			auctionStartPrice = BN.max(auctionStartPrice, limitPrice);
		}
	}

	return auctionStartPrice;
}

/**
 * Computes both the auction start price (`getTriggerAuctionStartPrice`) and the
 * corresponding execution price under the (potentially different) live MM oracle price —
 * i.e. the same start offset re-applied to `mmOraclePrice` instead of `oraclePrice`. Both are
 * clamped to `limitPrice` if one is given.
 * @param params.perpMarket Market providing TWAP stats and contract tier.
 * @param params.direction Order side.
 * @param params.oraclePrice Current (exchange) oracle price — use `OraclePriceData.price`, PRICE_PRECISION (1e6).
 * @param params.mmOraclePrice Current MM oracle price — use `MMOraclePriceData.price`, PRICE_PRECISION (1e6).
 * @param params.limitPrice Optional limit price to clamp both results to, PRICE_PRECISION (1e6).
 * @returns `startPrice` (auction start under `oraclePrice`) and `executionPrice` (same offset under `mmOraclePrice`), both PRICE_PRECISION (1e6).
 */
export function getTriggerAuctionStartAndExecutionPrice(params: {
	perpMarket: PerpMarketAccount;
	direction: PositionDirection;
	oraclePrice: BN;
	mmOraclePrice: BN;
	limitPrice?: BN;
}): { startPrice: BN; executionPrice: BN } {
	const { perpMarket, direction, oraclePrice, limitPrice, mmOraclePrice } =
		params;

	const startPrice = getTriggerAuctionStartPrice({
		perpMarket,
		direction,
		oraclePrice,
		limitPrice,
	});

	const offsetPlusBuffer = startPrice.sub(oraclePrice);
	let executionPrice = mmOraclePrice.add(offsetPlusBuffer);

	if (limitPrice) {
		if (isVariant(direction, 'long')) {
			executionPrice = BN.min(executionPrice, limitPrice);
		} else {
			executionPrice = BN.max(executionPrice, limitPrice);
		}
	}

	return { startPrice, executionPrice };
}
