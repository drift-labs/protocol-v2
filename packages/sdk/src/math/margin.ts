/**
 * Margin calculation helpers — TypeScript mirror of `programs/velocity/src/math/margin.rs`.
 * Computes initial/maintenance margin requirements, free collateral, and account health.
 * Used by `User` for leverage queries and by keeper bots for liquidation eligibility checks.
 */
import { squareRootBN } from './utils';
import {
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_IMF_PRECISION,
	ZERO,
	AMM_RESERVE_PRECISION,
	BASE_PRECISION,
	MARGIN_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
} from '../constants/numericConstants';
import { BN } from '../isomorphic/anchor';
import { OraclePriceData } from '../oracles/types';
import { calculateMarketMarginRatio } from './market';
import { calculateScaledInitialAssetWeight } from './spotBalance';
import { VelocityClient } from '../velocityClient';
import { PerpMarketAccount, PerpPosition } from '../types';
import { isVariant } from '../types';
import { assert } from '../assert/assert';

/**
 * Applies the IMF (initial margin factor) size premium to a base liability weight, mirroring
 * `calculate_size_premium_liability_weight` in `programs/velocity/src/math/margin.rs`. Larger
 * positions get a higher (worse) liability weight, scaling with `sqrt(size)`, so leverage
 * effectively decreases as position size grows. Returns `liabilityWeight` unchanged when
 * `imfFactor` is zero (IMF scaling disabled for the market).
 * @param size Position size driving the premium, AMM_RESERVE_PRECISION (1e9).
 * @param imfFactor Market's IMF factor, SPOT_MARKET_IMF_PRECISION (1e6) or the margin-ratio-scaled equivalent depending on caller.
 * @param liabilityWeight Base liability weight before the size premium, same precision as `precision`.
 * @param precision Precision `liabilityWeight` is expressed in (e.g. `MARGIN_PRECISION` 1e4 for perp margin ratios, `SPOT_MARKET_WEIGHT_PRECISION` 1e4 for spot weights).
 * @param isBounded If true (default), the result is floored at `liabilityWeight` (the premium can only increase it); if false, returns the raw (possibly lower) premium-adjusted value.
 * @returns Size-adjusted liability weight, same precision as `liabilityWeight`.
 */
export function calculateSizePremiumLiabilityWeight(
	size: BN, // AMM_RESERVE_PRECISION
	imfFactor: BN,
	liabilityWeight: BN,
	precision: BN,
	isBounded = true
): BN {
	if (imfFactor.eq(ZERO)) {
		return liabilityWeight;
	}

	const sizeSqrt = squareRootBN(size.abs().mul(new BN(10)).add(new BN(1))); //1e9 -> 1e10 -> 1e5

	const liabilityWeightNumerator = liabilityWeight.sub(
		liabilityWeight.div(new BN(5))
	);

	const denom = new BN(100_000).mul(SPOT_MARKET_IMF_PRECISION).div(precision);
	assert(denom.gt(ZERO));

	const sizePremiumLiabilityWeight = liabilityWeightNumerator.add(
		sizeSqrt // 1e5
			.mul(imfFactor)
			.div(denom) // 1e5
	);

	let maxLiabilityWeight;
	if (isBounded) {
		maxLiabilityWeight = BN.max(liabilityWeight, sizePremiumLiabilityWeight);
	} else {
		maxLiabilityWeight = sizePremiumLiabilityWeight;
	}

	return maxLiabilityWeight;
}

/**
 * Applies the IMF size discount to a base asset weight, mirroring
 * `calculate_size_discount_asset_weight` in `programs/velocity/src/math/margin.rs`. Larger
 * deposits get a lower (worse) asset weight, scaling down with `sqrt(size)`, capping how much
 * collateral credit a single large position can contribute. Returns `assetWeight` unchanged
 * when `imfFactor` is zero.
 * @param size Deposit size driving the discount, AMM_RESERVE_PRECISION (1e9).
 * @param imfFactor Market's IMF factor, SPOT_MARKET_IMF_PRECISION (1e6).
 * @param assetWeight Base asset weight before the size discount, SPOT_MARKET_WEIGHT_PRECISION (1e4).
 * @returns `min(assetWeight, sizeDiscountedWeight)`, SPOT_MARKET_WEIGHT_PRECISION (1e4).
 */
export function calculateSizeDiscountAssetWeight(
	size: BN, // AMM_RESERVE_PRECISION
	imfFactor: BN,
	assetWeight: BN
): BN {
	if (imfFactor.eq(ZERO)) {
		return assetWeight;
	}

	const sizeSqrt = squareRootBN(size.abs().mul(new BN(10)).add(new BN(1))); //1e9 -> 1e10 -> 1e5
	const imfNumerator = SPOT_MARKET_IMF_PRECISION.add(
		SPOT_MARKET_IMF_PRECISION.div(new BN(10))
	);

	const sizeDiscountAssetWeight = imfNumerator
		.mul(SPOT_MARKET_WEIGHT_PRECISION)
		.div(
			SPOT_MARKET_IMF_PRECISION.add(
				sizeSqrt // 1e5
					.mul(imfFactor)
					.div(new BN(100_000)) // 1e5
			)
		);

	const minAssetWeight = BN.min(assetWeight, sizeDiscountAssetWeight);

	return minAssetWeight;
}

/**
 * Marks a perp position (or its worst-case size including open orders) to the oracle price:
 * `abs(baseAssetAmount) * price / AMM_RESERVE_PRECISION`. Used for margin/health
 * calculations, not close-value simulation (see `calculateBaseAssetValue` in `position.ts`
 * for the AMM-simulated close value). This is a base *asset value*, not necessarily the same
 * as liability value in every case — see `calculatePerpLiabilityValue` to get the liability
 * value used directly in margin requirement math.
 * @param market Perp market the position belongs to; uses `market.expiryPrice` instead of the oracle price when the market is in `settlement` status.
 * @param perpPosition Position to value.
 * @param oraclePriceData Must provide `price`, PRICE_PRECISION (1e6).
 * @param includeOpenOrders If true, values the worst-case base amount including open bids/asks (via `calculateWorstCaseBaseAssetAmount`) instead of just the current position (default false).
 * @returns Base asset value, QUOTE_PRECISION (1e6).
 */
export function calculateBaseAssetValueWithOracle(
	market: PerpMarketAccount,
	perpPosition: PerpPosition,
	oraclePriceData: Pick<OraclePriceData, 'price'>,
	includeOpenOrders = false
): BN {
	let price = oraclePriceData.price;
	if (isVariant(market.status, 'settlement')) {
		price = market.expiryPrice;
	}

	const baseAssetAmount = includeOpenOrders
		? calculateWorstCaseBaseAssetAmount(
				perpPosition,
				market,
				oraclePriceData.price
		  )
		: perpPosition.baseAssetAmount;

	return baseAssetAmount.abs().mul(price).div(AMM_RESERVE_PRECISION);
}

/** Convenience wrapper returning just `worstCaseBaseAssetAmount` from `calculateWorstCasePerpLiabilityValue` — see that function for semantics and units (AMM_RESERVE_PRECISION, 1e9, signed). */
export function calculateWorstCaseBaseAssetAmount(
	perpPosition: PerpPosition,
	perpMarket: PerpMarketAccount,
	oraclePrice: BN
): BN {
	return calculateWorstCasePerpLiabilityValue(
		perpPosition,
		perpMarket,
		oraclePrice
	).worstCaseBaseAssetAmount;
}

/**
 * Computes the worst-case base position and liability value if all of a position's resting
 * orders on the more-adverse side were to fill, mirroring the program's worst-case-liability
 * margin methodology: compares the liability value of `baseAssetAmount + openBids` against
 * `baseAssetAmount + openAsks` and returns whichever is larger (i.e. whichever side, if
 * filled, would leave the user with more liability exposure). This is what margin
 * requirements are sized against, not the position's current base amount alone.
 * @param perpPosition Position providing `baseAssetAmount`, `openBids`, `openAsks`.
 * @param perpMarket Unused by this function (accepted for call-site symmetry with other market-scoped valuation helpers).
 * @param oraclePrice Oracle price, PRICE_PRECISION (1e6).
 * @param includeOpenOrders If false, skips the bids/asks comparison and returns the position's actual base amount/liability value as-is (default true).
 * @returns `worstCaseBaseAssetAmount` (AMM_RESERVE_PRECISION 1e9, signed) and `worstCaseLiabilityValue` (QUOTE_PRECISION 1e6) for the more-adverse side.
 */
export function calculateWorstCasePerpLiabilityValue(
	perpPosition: PerpPosition,
	perpMarket: PerpMarketAccount,
	oraclePrice: BN,
	includeOpenOrders: boolean = true
): { worstCaseBaseAssetAmount: BN; worstCaseLiabilityValue: BN } {
	// return early if no open orders required
	if (!includeOpenOrders) {
		return {
			worstCaseBaseAssetAmount: perpPosition.baseAssetAmount,
			worstCaseLiabilityValue: calculatePerpLiabilityValue(
				perpPosition.baseAssetAmount,
				oraclePrice
			),
		};
	}
	const allBids = perpPosition.baseAssetAmount.add(perpPosition.openBids);
	const allAsks = perpPosition.baseAssetAmount.add(perpPosition.openAsks);

	const allBidsLiabilityValue = calculatePerpLiabilityValue(
		allBids,
		oraclePrice
	);
	const allAsksLiabilityValue = calculatePerpLiabilityValue(
		allAsks,
		oraclePrice
	);

	if (allAsksLiabilityValue.gte(allBidsLiabilityValue)) {
		return {
			worstCaseBaseAssetAmount: allAsks,
			worstCaseLiabilityValue: allAsksLiabilityValue,
		};
	} else {
		return {
			worstCaseBaseAssetAmount: allBids,
			worstCaseLiabilityValue: allBidsLiabilityValue,
		};
	}
}

/**
 * Liability value of a base amount at a given price: `abs(baseAssetAmount) * price / BASE_PRECISION`.
 * This is the value margin requirements are computed against.
 * @param baseAssetAmount Base amount, BASE_PRECISION (1e9, signed).
 * @param price Price, PRICE_PRECISION (1e6).
 * @returns Liability value, QUOTE_PRECISION (1e6).
 */
export function calculatePerpLiabilityValue(
	baseAssetAmount: BN,
	price: BN
): BN {
	return baseAssetAmount.abs().mul(price).div(BASE_PRECISION);
}

/**
 * Calculates the margin required to open a trade, in quote amount. Only accounts for the
 * trade size as a scalar value — does not account for the trade direction, current open
 * positions, or whether the trade would _actually_ be risk-increasing and use any extra
 * collateral (i.e. it's an upper-bound estimate for a standalone new position, not a
 * risk-increase delta).
 * @param velocityClient Client used to look up the target market and its oracle price.
 * @param targetMarketIndex Perp market index of the trade.
 * @param baseSize Trade size, BASE_PRECISION (1e9).
 * @param userMaxMarginRatio Optional per-user max margin ratio override (MARGIN_PRECISION, 1e4) — forwarded to `calculateMarketMarginRatio`; if omitted, the market's default initial margin ratio is used (subject to the size premium).
 * @param entryPrice Optional price to value the trade at instead of the current oracle price, PRICE_PRECISION (1e6).
 * @returns Margin required, QUOTE_PRECISION (1e6).
 */
export function calculateMarginUSDCRequiredForTrade(
	velocityClient: VelocityClient,
	targetMarketIndex: number,
	baseSize: BN,
	userMaxMarginRatio?: number,
	entryPrice?: BN
): BN {
	const targetMarket =
		velocityClient.getPerpMarketAccountOrThrow(targetMarketIndex);

	const price =
		entryPrice ??
		velocityClient.getOracleDataForPerpMarket(targetMarket.marketIndex).price;

	const perpLiabilityValue = calculatePerpLiabilityValue(baseSize, price);

	const marginRequired = new BN(
		calculateMarketMarginRatio(
			targetMarket,
			baseSize.abs(),
			'Initial',
			userMaxMarginRatio
		)
	)
		.mul(perpLiabilityValue)
		.div(MARGIN_PRECISION);

	return marginRequired;
}

/**
 * Similar to `calculateMarginUSDCRequiredForTrade`, but calculates how much of a given
 * collateral asset is required to cover the margin requirement for a given trade —
 * additionally accounts for the collateral's scaled initial asset weight (via
 * `calculateScaledInitialAssetWeight`), so a lower-weight collateral (e.g. a volatile asset)
 * requires depositing more than its face USDC value would suggest.
 * @param velocityClient Client used to look up the target/collateral markets and oracle prices.
 * @param targetMarketIndex Perp market index of the trade.
 * @param baseSize Trade size, BASE_PRECISION (1e9).
 * @param collateralIndex Spot market index of the collateral asset to deposit.
 * @param userMaxMarginRatio Optional per-user max margin ratio override (MARGIN_PRECISION, 1e4), forwarded to `calculateMarginUSDCRequiredForTrade`.
 * @param estEntryPrice Optional price to value the trade at instead of the current oracle price, PRICE_PRECISION (1e6).
 * @returns Collateral amount required, in `collateralIndex`'s own spot-market precision (via `velocityClient.convertToSpotPrecision`).
 */
export function calculateCollateralDepositRequiredForTrade(
	velocityClient: VelocityClient,
	targetMarketIndex: number,
	baseSize: BN,
	collateralIndex: number,
	userMaxMarginRatio?: number,
	estEntryPrice?: BN
): BN {
	const marginRequiredUsdc = calculateMarginUSDCRequiredForTrade(
		velocityClient,
		targetMarketIndex,
		baseSize,
		userMaxMarginRatio,
		estEntryPrice
	);

	const collateralMarket =
		velocityClient.getSpotMarketAccountOrThrow(collateralIndex);

	const collateralOracleData =
		velocityClient.getOracleDataForSpotMarket(collateralIndex);

	const scaledAssetWeight = calculateScaledInitialAssetWeight(
		collateralMarket,
		collateralOracleData.price
	);

	// Base amount required to deposit = (marginRequiredUsdc / priceOfAsset) / assetWeight .. (E.g. $100 required / $10000 price / 0.5 weight)
	const baseAmountRequired = velocityClient
		.convertToSpotPrecision(collateralIndex, marginRequiredUsdc)
		.mul(PRICE_PRECISION) // adjust for division by oracle price
		.mul(SPOT_MARKET_WEIGHT_PRECISION) // adjust for division by scaled asset weight
		.div(collateralOracleData.price)
		.div(scaledAssetWeight)
		.div(QUOTE_PRECISION); // adjust for marginRequiredUsdc value's QUOTE_PRECISION

	// TODO : Round by step size?

	return baseAmountRequired;
}
