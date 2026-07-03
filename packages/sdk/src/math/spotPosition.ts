import { MarginCategory, SpotMarketAccount, SpotPosition } from '../types';
import {
	QUOTE_SPOT_MARKET_INDEX,
	SPOT_MARKET_WEIGHT_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { BN } from '../isomorphic/anchor';
import {
	calculateAssetWeight,
	calculateLiabilityWeight,
	getSignedTokenAmount,
	getStrictTokenValue,
	getTokenAmount,
	getTokenValue,
} from './spotBalance';
import { StrictOraclePrice } from '../oracles/strictOraclePrice';

/**
 * True if a `SpotPosition` slot has no balance and no open orders, meaning it is free to be
 * reused (or shown as empty) rather than representing an active position.
 *
 * @param {SpotPosition} position - The spot position
 * @return {boolean} Whether the slot is unused
 */
export function isSpotPositionAvailable(position: SpotPosition): boolean {
	return position.scaledBalance.eq(ZERO) && position.openOrders === 0;
}

/**
 * Result of simulating a spot position's collateral contribution, optionally after its resting
 * open orders are assumed to fill. All quote-denominated fields are `PRICE_PRECISION` (1e6).
 */
export type OrderFillSimulation = {
	/** Signed token amount (base for non-quote markets), the market's token decimals */
	tokenAmount: BN;
	/** Value of the open orders assumed to fill, at the worst-case (max) oracle price */
	ordersValue: BN;
	/** Strict-oracle value of `tokenAmount` before margin weighting */
	tokenValue: BN;
	/** Asset or liability weight applied to `tokenValue`, `SPOT_MARKET_WEIGHT_PRECISION` (1e4) */
	weight: BN;
	/** `tokenValue` after applying `weight` */
	weightedTokenValue: BN;
	/** Net contribution to free collateral: `weightedTokenValue` plus `ordersValue` where applicable */
	freeCollateralContribution: BN;
};

/**
 * Calculates a spot position's worst-case token amount and margin contribution, accounting for
 * the possibility that its resting open bids or asks could fill. Mirrors the program's
 * worst-case spot balance logic used in margin/health checks: if both `openBids` and `openAsks`
 * are zero (or `includeOpenOrders` is false), the position's current balance is valued as-is;
 * otherwise the function separately simulates full fill of the bids and of the asks
 * (`simulateOrderFill`) and returns whichever leaves the *lower* `freeCollateralContribution` —
 * i.e. the more conservative (worse-case) scenario for margin purposes.
 *
 * @param {SpotPosition} spotPosition - The user's spot position
 * @param {SpotMarketAccount} spotMarketAccount - The spot market account
 * @param {StrictOraclePrice} strictOraclePrice - Live oracle price + 5min TWAP, PRICE_PRECISION (1e6)
 * @param {MarginCategory | undefined} marginCategory - `'Initial'`, `'Maintenance'`, or
 *   `undefined` for an unweighted valuation
 * @param {number} [customMarginRatio] - User's custom max margin ratio (`'Initial'` only); see
 *   `calculateWeightedTokenValue`
 * @param {boolean} [includeOpenOrders] - Whether to simulate open order fills at all; defaults
 *   to `true`. When `false`, only the current balance is valued regardless of open orders.
 * @return {OrderFillSimulation} The worst-case simulation result
 */
export function getWorstCaseTokenAmounts(
	spotPosition: SpotPosition,
	spotMarketAccount: SpotMarketAccount,
	strictOraclePrice: StrictOraclePrice,
	marginCategory: MarginCategory | undefined,
	customMarginRatio?: number,
	includeOpenOrders: boolean = true
): OrderFillSimulation {
	const tokenAmount = getSignedTokenAmount(
		getTokenAmount(
			spotPosition.scaledBalance,
			spotMarketAccount,
			spotPosition.balanceType
		),
		spotPosition.balanceType
	);

	const tokenValue = getStrictTokenValue(
		tokenAmount,
		spotMarketAccount.decimals,
		strictOraclePrice
	);

	if (
		(spotPosition.openBids.eq(ZERO) && spotPosition.openAsks.eq(ZERO)) ||
		!includeOpenOrders
	) {
		const { weight, weightedTokenValue } = calculateWeightedTokenValue(
			tokenAmount,
			tokenValue,
			strictOraclePrice.current,
			spotMarketAccount,
			marginCategory,
			customMarginRatio
		);
		return {
			tokenAmount,
			ordersValue: ZERO,
			tokenValue,
			weight,
			weightedTokenValue,
			freeCollateralContribution: weightedTokenValue,
		};
	}

	const bidsSimulation = simulateOrderFill(
		tokenAmount,
		tokenValue,
		spotPosition.openBids,
		strictOraclePrice,
		spotMarketAccount,
		marginCategory,
		customMarginRatio
	);
	const asksSimulation = simulateOrderFill(
		tokenAmount,
		tokenValue,
		spotPosition.openAsks,
		strictOraclePrice,
		spotMarketAccount,
		marginCategory,
		customMarginRatio
	);

	if (
		asksSimulation.freeCollateralContribution.lt(
			bidsSimulation.freeCollateralContribution
		)
	) {
		return asksSimulation;
	} else {
		return bidsSimulation;
	}
}

/**
 * Applies the appropriate asset or liability weight (based on the sign of `tokenValue`) to a
 * token value, mirroring the program's `calculate_weighted_token_value` closure used in both
 * plain and worst-case-fill spot margin calculations.
 *
 * @param {BN} tokenAmount - Signed token amount, used (as `abs()`) for the IMF size adjustment
 * @param {BN} tokenValue - Signed strict-oracle value, `PRICE_PRECISION` (1e6); sign selects
 *   asset weight (`>= 0`) vs liability weight (`< 0`)
 * @param {BN} oraclePrice - The oracle price, PRICE_PRECISION (1e6), passed through to
 *   `calculateAssetWeight` for the initial-weight deposit-value scaling lookup
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @param {MarginCategory | undefined} marginCategory - `'Initial'`, `'Maintenance'`, or `undefined`
 * @param {number} [customMarginRatio] - User's custom max margin ratio, `SPOT_MARKET_WEIGHT_PRECISION`
 *   (1e4) units; only applied for `'Initial'` on non-quote markets, tightening (never loosening)
 *   the weight in the direction unfavorable to the user
 * @return {{ weight: BN; weightedTokenValue: BN }} `weight` in `SPOT_MARKET_WEIGHT_PRECISION`
 *   (1e4); `weightedTokenValue` in `PRICE_PRECISION` (1e6)
 */
export function calculateWeightedTokenValue(
	tokenAmount: BN,
	tokenValue: BN,
	oraclePrice: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory | undefined,
	customMarginRatio?: number
): { weight: BN; weightedTokenValue: BN } {
	let weight: BN;
	if (tokenValue.gte(ZERO)) {
		weight = calculateAssetWeight(
			tokenAmount,
			oraclePrice,
			spotMarket,
			marginCategory
		);
	} else {
		weight = calculateLiabilityWeight(
			tokenAmount.abs(),
			spotMarket,
			marginCategory
		);
	}

	if (
		marginCategory === 'Initial' &&
		customMarginRatio &&
		spotMarket.marketIndex !== QUOTE_SPOT_MARKET_INDEX
	) {
		const userCustomAssetWeight = tokenValue.gte(ZERO)
			? BN.max(
					ZERO,
					SPOT_MARKET_WEIGHT_PRECISION.sub(new BN(customMarginRatio))
			  )
			: SPOT_MARKET_WEIGHT_PRECISION.add(new BN(customMarginRatio));

		weight = tokenValue.gte(ZERO)
			? BN.min(weight, userCustomAssetWeight)
			: BN.max(weight, userCustomAssetWeight);
	}

	return {
		weight: weight,
		weightedTokenValue: tokenValue
			.mul(weight)
			.div(SPOT_MARKET_WEIGHT_PRECISION),
	};
}

/**
 * Simulates one side (bids or asks) of a spot position's open orders fully filling, and
 * recomputes the resulting margin contribution. Mirrors the per-side branch of the program's
 * `simulate_fills_both_sides`. The filled orders' value is valued at the *worst-case* price
 * (`strictOraclePrice.max()`) regardless of side, since filling either bids or asks moves the
 * position further from its current state in the direction that could hurt collateral value.
 *
 * @param {BN} tokenAmount - Current signed token amount before the simulated fill
 * @param {BN} tokenValue - Current strict-oracle token value before the simulated fill, `PRICE_PRECISION` (1e6)
 * @param {BN} openOrders - Signed open order base size for this side: `spotPosition.openBids`
 *   (stored positive) or `spotPosition.openAsks` (stored negative), the market's token decimals
 * @param {StrictOraclePrice} strictOraclePrice - Live oracle price + 5min TWAP, PRICE_PRECISION (1e6)
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @param {MarginCategory | undefined} marginCategory - `'Initial'`, `'Maintenance'`, or `undefined`
 * @param {number} [customMarginRatio] - User's custom max margin ratio; see `calculateWeightedTokenValue`
 * @return {OrderFillSimulation} The post-fill simulation for this side
 */
export function simulateOrderFill(
	tokenAmount: BN,
	tokenValue: BN,
	openOrders: BN,
	strictOraclePrice: StrictOraclePrice,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory | undefined,
	customMarginRatio?: number
): OrderFillSimulation {
	const ordersValue = getTokenValue(openOrders.neg(), spotMarket.decimals, {
		price: strictOraclePrice.max(),
	});
	const tokenAmountAfterFill = tokenAmount.add(openOrders);
	const tokenValueAfterFill = tokenValue.add(ordersValue.neg());

	const { weight, weightedTokenValue: weightedTokenValueAfterFill } =
		calculateWeightedTokenValue(
			tokenAmountAfterFill,
			tokenValueAfterFill,
			strictOraclePrice.current,
			spotMarket,
			marginCategory,
			customMarginRatio
		);

	const freeCollateralContribution =
		weightedTokenValueAfterFill.add(ordersValue);

	return {
		tokenAmount: tokenAmountAfterFill,
		ordersValue: ordersValue,
		tokenValue: tokenValueAfterFill,
		weight,
		weightedTokenValue: weightedTokenValueAfterFill,
		freeCollateralContribution,
	};
}
