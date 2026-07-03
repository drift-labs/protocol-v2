import { BN } from '../isomorphic/anchor';
import {
	PRICE_PRECISION,
	LIQUIDATION_FEE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	LIQUIDATION_PCT_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	BASE_PRECISION,
	TEN,
	ONE,
	ZERO,
} from '../constants/numericConstants';

/**
 * Calculates the base asset amount a liquidator must take from a perp position to cover a
 * given margin shortage, mirroring `calculate_base_asset_amount_to_cover_margin_shortage` in
 * `programs/velocity/src/math/liquidation.rs`. Larger `marginRatio`/`liquidationFee` spread
 * (the liquidator's margin) means less base asset amount is needed per dollar of shortage
 * covered; the `ifLiquidationFee` cut is subtracted from the liquidator's proceeds first.
 * @param marginShortage Margin shortfall to cover, QUOTE_PRECISION (1e6).
 * @param marginRatio Position's maintenance margin ratio, MARGIN_PRECISION (1e4).
 * @param liquidationFee Liquidator's fee rate, LIQUIDATION_FEE_PRECISION (1e6).
 * @param ifLiquidationFee The margin-shortage-aware insurance-side fee, i.e. the
 *   output of `calculatePerpIfFee` (which is itself capped at
 *   `market.ifLiquidationFee + market.protocolLiquidationFee`). Pass that
 *   computed value here, not the raw `ifLiquidationFee + protocolLiquidationFee`
 *   sum — the on-chain sizing uses the capped, shortage-aware amount.
 * @param oraclePrice Oracle price of the perp market, PRICE_PRECISION (1e6).
 * @param quoteOraclePrice Oracle price of the quote asset, PRICE_PRECISION (1e6).
 * @returns Base asset amount to transfer, BASE_PRECISION (1e9); `undefined` means "no finite
 *   amount can cover the shortage" (oracle price is zero, or the margin ratio doesn't exceed
 *   the liquidation fee) — treat as unbounded/take the whole position.
 */
export function calculateBaseAssetAmountToCoverMarginShortage(
	marginShortage: BN,
	marginRatio: number,
	liquidationFee: number,
	ifLiquidationFee: number,
	oraclePrice: BN,
	quoteOraclePrice: BN
): BN | undefined {
	const marginRatioBN = new BN(marginRatio)
		.mul(LIQUIDATION_FEE_PRECISION)
		.div(MARGIN_PRECISION);
	const liquidationFeeBN = new BN(liquidationFee);

	if (oraclePrice.eq(new BN(0)) || marginRatioBN.lte(liquidationFeeBN)) {
		// undefined is max
		return undefined;
	}

	return marginShortage.mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO).div(
		oraclePrice
			.mul(quoteOraclePrice)
			.div(PRICE_PRECISION)
			.mul(marginRatioBN.sub(liquidationFeeBN))
			.div(LIQUIDATION_FEE_PRECISION)
			.sub(
				oraclePrice.mul(new BN(ifLiquidationFee)).div(LIQUIDATION_FEE_PRECISION)
			)
	);
}

/**
 * Calculates the spot liability token amount a liquidator must take to cover a given margin
 * shortage, mirroring `calculate_liability_transfer_to_cover_margin_shortage` in
 * `programs/velocity/src/math/liquidation.rs`. Scales with the gap between the asset and
 * liability weights (adjusted by their respective liquidation multipliers) — a wider spread
 * means less liability token amount is needed per dollar of shortage covered.
 * @param marginShortage Margin shortfall to cover, QUOTE_PRECISION (1e6).
 * @param assetWeight Weight of the collateral asset the liquidator gives up, SPOT_MARKET_WEIGHT_PRECISION (1e4).
 * @param assetLiquidationMultiplier Liquidation-time discount multiplier on the asset side, LIQUIDATION_FEE_PRECISION (1e6).
 * @param liabilityWeight Weight of the liability being repaid, SPOT_MARKET_WEIGHT_PRECISION (1e4).
 * @param liabilityLiquidationMultiplier Liquidation-time premium multiplier on the liability side, LIQUIDATION_FEE_PRECISION (1e6).
 * @param liabilityDecimals Liability spot market's token decimals.
 * @param liabilityPrice Oracle price of the liability asset, PRICE_PRECISION (1e6).
 * @param ifLiquidationFee The margin-shortage-aware insurance-side fee, i.e. the
 *   output of `calculateSpotIfFee` (which is itself capped at
 *   `liabilityMarket.ifLiquidationFee + liabilityMarket.protocolLiquidationFee`).
 *   Pass that computed value here, not the raw sum of the two rates — the
 *   on-chain sizing uses the capped, shortage-aware amount.
 * @returns Liability token amount to transfer, in the liability spot market's own token
 *   precision (`10^liabilityDecimals`); `undefined` means "no finite amount can cover the
 *   shortage" (`assetWeight >= liabilityWeight`, or the effective spread is non-positive) —
 *   treat as unbounded/take the whole liability.
 */
export function calculateLiabilityTransferToCoverMarginShortage(
	marginShortage: BN,
	assetWeight: number,
	assetLiquidationMultiplier: number,
	liabilityWeight: number,
	liabilityLiquidationMultiplier: number,
	liabilityDecimals: number,
	liabilityPrice: BN,
	ifLiquidationFee: number
): BN | undefined {
	if (assetWeight >= liabilityWeight) {
		// undefined is max
		return undefined;
	}

	let numeratorScale: BN;
	let denominatorScale: BN;
	if (liabilityDecimals > 6) {
		numeratorScale = new BN(10).pow(new BN(liabilityDecimals - 6));
		denominatorScale = new BN(1);
	} else {
		numeratorScale = new BN(1);
		denominatorScale = new BN(10).pow(new BN(6 - liabilityDecimals));
	}

	// multiply market weights by extra 10 to increase precision
	const liabilityWeightComponent = liabilityWeight * 10;
	const assetWeightComponent =
		(assetWeight * 10 * assetLiquidationMultiplier) /
		liabilityLiquidationMultiplier;

	if (assetWeightComponent >= liabilityWeightComponent) {
		return undefined;
	}

	return BN.max(
		marginShortage
			.mul(numeratorScale)
			.mul(PRICE_PRECISION.mul(SPOT_MARKET_WEIGHT_PRECISION).mul(TEN))
			.div(
				liabilityPrice
					.mul(
						new BN(liabilityWeightComponent).sub(new BN(assetWeightComponent))
					)
					.sub(
						liabilityPrice
							.mul(new BN(ifLiquidationFee))
							.div(LIQUIDATION_FEE_PRECISION)
							.mul(new BN(liabilityWeight))
							.mul(new BN(10))
					)
			)
			.div(denominatorScale),
		ONE
	);
}

/**
 * Calculates the margin-shortage-aware insurance-fund fee for liquidating a perp position,
 * mirroring `calculate_perp_if_fee` in `programs/velocity/src/math/liquidation.rs`. Starts
 * from `marginRatio - liquidatorFee` (the room left after the liquidator's own cut) and
 * subtracts a shortage-proportional deduction so the IF fee shrinks as the shortage grows
 * relative to position value — this is the "shortage-aware" behavior referenced by
 * `calculateBaseAssetAmountToCoverMarginShortage`'s `ifLiquidationFee` param. The result is
 * further scaled by 95% (to avoid the fee itself pushing the user into bankruptcy) and capped
 * at `maxIfLiquidationFee` (typically `market.ifLiquidationFee + market.protocolLiquidationFee`).
 * @param marginShortage Margin shortfall being covered, QUOTE_PRECISION (1e6).
 * @param userBaseAssetAmount Base amount being liquidated, BASE_PRECISION (1e9, signed — only magnitude matters).
 * @param marginRatio Position's maintenance margin ratio, MARGIN_PRECISION (1e4).
 * @param liquidatorFee Liquidator's fee rate, LIQUIDATION_FEE_PRECISION (1e6).
 * @param oraclePrice Oracle price of the perp market, PRICE_PRECISION (1e6).
 * @param quoteOraclePrice Oracle price of the quote asset, PRICE_PRECISION (1e6).
 * @param maxIfLiquidationFee Upper bound on the returned fee, LIQUIDATION_FEE_PRECISION (1e6).
 * @returns Insurance-fund fee rate, LIQUIDATION_FEE_PRECISION (1e6); `0` if either oracle
 *   price is zero, the position size is zero, or `marginRatio` doesn't exceed `liquidatorFee`.
 */
export function calculatePerpIfFee(
	marginShortage: BN,
	userBaseAssetAmount: BN,
	marginRatio: number,
	liquidatorFee: number,
	oraclePrice: BN,
	quoteOraclePrice: BN,
	maxIfLiquidationFee: number
): number {
	const marginRatioBN = new BN(marginRatio).mul(
		LIQUIDATION_FEE_PRECISION.div(MARGIN_PRECISION)
	);

	if (
		oraclePrice.eq(ZERO) ||
		quoteOraclePrice.eq(ZERO) ||
		marginRatioBN.lte(new BN(liquidatorFee)) ||
		userBaseAssetAmount.eq(ZERO)
	) {
		return 0;
	}

	const price = oraclePrice.mul(quoteOraclePrice).div(PRICE_PRECISION);

	// margin ratio - liquidator fee - (margin shortage / (user base asset amount * price))
	// the program receives base_asset_amount.unsigned_abs() (u64), so only the magnitude
	// participates in the shortage term
	let impliedIfFee = BN.max(marginRatioBN.sub(new BN(liquidatorFee)), ZERO);
	const shortageComponent = marginShortage
		.mul(BASE_PRECISION)
		.div(userBaseAssetAmount.abs())
		.mul(PRICE_PRECISION)
		.div(price);
	impliedIfFee = BN.max(impliedIfFee.sub(shortageComponent), ZERO);

	// multiply by 95% to avoid situation where fee leads to deposits == negative pnl
	// leading to bankruptcy
	impliedIfFee = impliedIfFee.mul(new BN(19)).div(new BN(20));

	return BN.min(new BN(maxIfLiquidationFee), impliedIfFee).toNumber();
}

/**
 * Calculates the margin-shortage-aware insurance-fund fee for a spot liability liquidation,
 * mirroring `calculate_spot_if_fee` in `programs/velocity/src/math/liquidation.rs`. Same
 * shortage-aware shape as `calculatePerpIfFee`: starts from the asset/liability weight
 * spread (scaled by their liquidation multipliers), subtracts a shortage-proportional
 * deduction, and caps at `maxIfFee` (typically `liabilityMarket.ifLiquidationFee +
 * liabilityMarket.protocolLiquidationFee`).
 * @param marginShortage Margin shortfall being covered, QUOTE_PRECISION (1e6).
 * @param tokenAmount Liability token amount being liquidated, liability spot market's own token precision (`10^liabilityDecimals`).
 * @param assetWeight Weight of the collateral asset the liquidator gives up, SPOT_MARKET_WEIGHT_PRECISION (1e4).
 * @param assetLiquidationMultiplier Liquidation-time discount multiplier on the asset side, LIQUIDATION_FEE_PRECISION (1e6).
 * @param liabilityWeight Weight of the liability being repaid, SPOT_MARKET_WEIGHT_PRECISION (1e4).
 * @param liabilityLiquidationMultiplier Liquidation-time premium multiplier on the liability side, LIQUIDATION_FEE_PRECISION (1e6).
 * @param liabilityDecimals Liability spot market's token decimals.
 * @param liabilityPrice Oracle price of the liability asset, PRICE_PRECISION (1e6).
 * @param maxIfFee Upper bound on the returned fee, LIQUIDATION_FEE_PRECISION (1e6).
 * @returns Insurance-fund fee rate, LIQUIDATION_FEE_PRECISION (1e6); `0` if
 *   `assetWeight >= liabilityWeight`, the liability price/token amount is zero, or
 *   `liabilityLiquidationMultiplier` is zero.
 */
export function calculateSpotIfFee(
	marginShortage: BN,
	tokenAmount: BN,
	assetWeight: number,
	assetLiquidationMultiplier: number,
	liabilityWeight: number,
	liabilityLiquidationMultiplier: number,
	liabilityDecimals: number,
	liabilityPrice: BN,
	maxIfFee: number
): number {
	if (
		assetWeight >= liabilityWeight ||
		liabilityPrice.eq(ZERO) ||
		tokenAmount.eq(ZERO) ||
		liabilityLiquidationMultiplier === 0
	) {
		return 0;
	}

	const tokenPrecision = TEN.pow(new BN(liabilityDecimals));

	const weightPrecisionRatio = LIQUIDATION_FEE_PRECISION.div(
		SPOT_MARKET_WEIGHT_PRECISION
	);
	const liabilityWeightBN = new BN(liabilityWeight).mul(weightPrecisionRatio);
	const assetWeightBN = new BN(assetWeight).mul(weightPrecisionRatio);

	let impliedIfFee = BN.max(
		liabilityWeightBN.sub(
			assetWeightBN
				.mul(new BN(assetLiquidationMultiplier))
				.div(new BN(liabilityLiquidationMultiplier))
		),
		ZERO
	);

	const shortageComponent = marginShortage
		.mul(LIQUIDATION_FEE_PRECISION)
		.mul(tokenPrecision)
		.div(tokenAmount)
		.div(liabilityPrice);
	impliedIfFee = BN.max(impliedIfFee.sub(shortageComponent), ZERO);

	impliedIfFee = impliedIfFee
		.mul(LIQUIDATION_FEE_PRECISION)
		.div(liabilityWeightBN);

	return BN.min(new BN(maxIfFee), impliedIfFee).toNumber();
}

/**
 * Calculates how much of a liquidated user's collateral asset a liquidator receives in
 * exchange for repaying `liabilityAmount` of a liability, mirroring
 * `calculate_asset_transfer_for_liability_transfer` in
 * `programs/velocity/src/math/liquidation.rs`. Converts the liability amount to an
 * equivalent asset amount at the two assets' oracle prices, scaled by their respective
 * liquidation multipliers (the premium/discount applied at liquidation), then rounds up to
 * the user's full remaining asset balance (`assetAmount`) if the difference is under
 * `QUOTE_PRECISION` (1e6) worth of value — avoiding dust asset balances left behind.
 * @param assetAmount User's available balance of the asset being transferred, asset spot market's own token precision.
 * @param assetLiquidationMultiplier Liquidation-time discount multiplier on the asset side, LIQUIDATION_FEE_PRECISION (1e6).
 * @param assetDecimals Asset spot market's token decimals.
 * @param assetPrice Oracle price of the asset, PRICE_PRECISION (1e6).
 * @param liabilityAmount Liability amount being repaid, liability spot market's own token precision.
 * @param liabilityLiquidationMultiplier Liquidation-time premium multiplier on the liability side, LIQUIDATION_FEE_PRECISION (1e6).
 * @param liabilityDecimals Liability spot market's token decimals.
 * @param liabilityPrice Oracle price of the liability asset, PRICE_PRECISION (1e6).
 * @returns Asset amount to transfer to the liquidator, asset spot market's own token precision (floored at 1).
 */
export function calculateAssetTransferForLiabilityTransfer(
	assetAmount: BN,
	assetLiquidationMultiplier: number,
	assetDecimals: number,
	assetPrice: BN,
	liabilityAmount: BN,
	liabilityLiquidationMultiplier: number,
	liabilityDecimals: number,
	liabilityPrice: BN
): BN | undefined {
	let numeratorScale: BN;
	let denominatorScale: BN;
	if (assetDecimals > liabilityDecimals) {
		numeratorScale = new BN(10).pow(new BN(assetDecimals - liabilityDecimals));
		denominatorScale = new BN(1);
	} else {
		numeratorScale = new BN(1);
		denominatorScale = new BN(10).pow(
			new BN(liabilityDecimals - assetDecimals)
		);
	}

	let assetTransfer = liabilityAmount
		.mul(numeratorScale)
		.mul(liabilityPrice)
		.mul(new BN(assetLiquidationMultiplier))
		.div(assetPrice.mul(new BN(liabilityLiquidationMultiplier)))
		.div(denominatorScale);
	assetTransfer = BN.max(assetTransfer, ONE);

	// Need to check if asset_transfer should be rounded to asset amount
	let assetValueNumeratorScale: BN;
	let assetValueDenominatorScale: BN;
	if (assetDecimals > 6) {
		assetValueNumeratorScale = new BN(10).pow(new BN(assetDecimals - 6));
		assetValueDenominatorScale = new BN(1);
	} else {
		assetValueNumeratorScale = new BN(1);
		assetValueDenominatorScale = new BN(10).pow(new BN(6 - assetDecimals));
	}

	let assetDelta: BN;
	if (assetTransfer > assetAmount) {
		assetDelta = assetTransfer.sub(assetAmount);
	} else {
		assetDelta = assetAmount.sub(assetTransfer);
	}

	const assetValueDelta = assetDelta
		.mul(assetPrice)
		.div(PRICE_PRECISION)
		.mul(assetValueNumeratorScale)
		.div(assetValueDenominatorScale);

	if (assetValueDelta.lt(QUOTE_PRECISION)) {
		assetTransfer = assetAmount;
	}

	return assetTransfer;
}

/**
 * Calculates the fraction of a position's remaining liability a liquidator may currently
 * take, mirroring `calculate_max_pct_to_liquidate` in
 * `programs/velocity/src/math/liquidation.rs`. Liquidations ramp up gradually over
 * `liquidationDuration` slots (starting from `initialPctToLiquidate`) rather than allowing
 * 100% in one shot, so a user isn't force-closed more aggressively than necessary — except:
 * isolated perp positions (`isIsolatedPosition`) are always liquidated 100% in one shot
 * since they have no other cross-margin exposure to protect, and any position is liquidated
 * 100% immediately once `marginShortage` is under $50 (dust threshold, not worth ramping).
 * @param userLastActiveSlot Slot the user was last active (start of the liquidation ramp), used with `slot` to compute elapsed time.
 * @param userLiquidationMarginFreed Margin already freed by liquidation actions so far this liquidation, QUOTE_PRECISION (1e6).
 * @param marginShortage Total margin shortfall for the user/position, QUOTE_PRECISION (1e6).
 * @param slot Current slot.
 * @param initialPctToLiquidate Starting liquidatable fraction at slot zero of the ramp, LIQUIDATION_PCT_PRECISION (1e4).
 * @param liquidationDuration Number of slots for the ramp to reach 100% (~1 minute at 400ms/slot for the on-chain default).
 * @param isIsolatedPosition If true, always returns 100% (LIQUIDATION_PCT_PRECISION) regardless of the other inputs (default false).
 * @returns Fraction of the remaining liability liquidatable now, LIQUIDATION_PCT_PRECISION (1e4).
 */
export function calculateMaxPctToLiquidate(
	userLastActiveSlot: BN,
	userLiquidationMarginFreed: BN,
	marginShortage: BN,
	slot: BN,
	initialPctToLiquidate: BN,
	liquidationDuration: BN,
	isIsolatedPosition = false
): BN {
	// isolated perp positions are liquidated 100% in one shot
	if (isIsolatedPosition) {
		return LIQUIDATION_PCT_PRECISION;
	}

	// if margin shortage is tiny, accelerate liquidation
	if (marginShortage.lt(new BN(50).mul(QUOTE_PRECISION))) {
		return LIQUIDATION_PCT_PRECISION;
	}

	const slotsElapsed = BN.max(slot.sub(userLastActiveSlot), new BN(0));

	const pctFreeable = BN.min(
		slotsElapsed
			.mul(LIQUIDATION_PCT_PRECISION)
			.div(liquidationDuration) // ~ 1 minute if per slot is 400ms
			.add(initialPctToLiquidate),
		LIQUIDATION_PCT_PRECISION
	);

	const totalMarginShortage = marginShortage.add(userLiquidationMarginFreed);
	const maxMarginFreed = totalMarginShortage
		.mul(pctFreeable)
		.div(LIQUIDATION_PCT_PRECISION);
	const marginFreeable = BN.max(
		maxMarginFreed.sub(userLiquidationMarginFreed),
		new BN(0)
	);

	return marginFreeable.mul(LIQUIDATION_PCT_PRECISION).div(marginShortage);
}

/**
 * Absolute margin shortfall between a (buffered) maintenance margin requirement and total
 * collateral. Returns a positive magnitude regardless of which side is larger — callers
 * typically only call this once `meetsMarginRequirementWithBuffer()` has already returned
 * `false`, at which point the result is the true shortage to cover.
 * @param maintenanceMarginRequirementPlusBuffer Buffered maintenance margin requirement, QUOTE_PRECISION (1e6).
 * @param maintenanceTotalCollateral Total collateral at maintenance weights, QUOTE_PRECISION (1e6).
 * @returns `abs(maintenanceMarginRequirementPlusBuffer - maintenanceTotalCollateral)`, QUOTE_PRECISION (1e6).
 */
export function getMarginShortage(
	maintenanceMarginRequirementPlusBuffer: BN,
	maintenanceTotalCollateral: BN
): BN {
	return maintenanceMarginRequirementPlusBuffer
		.sub(maintenanceTotalCollateral)
		.abs();
}
