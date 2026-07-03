import { BN } from '../isomorphic/anchor';
import {
	isVariant,
	MarginCategory,
	SpotBalanceType,
	SpotMarketAccount,
} from '../types';
import {
	calculateAssetWeight,
	calculateLiabilityWeight,
	getTokenAmount,
} from './spotBalance';
import { MARGIN_PRECISION, ZERO } from '../constants/numericConstants';
import { numberToSafeBN } from './utils';

/**
 * Converts a human-readable number or `BN` into the spot market's on-chain token precision
 * (`10 ** spotMarket.decimals`). Both inputs are treated as whole-token amounts and multiplied
 * by the market's precision.
 *
 * @param {number | BN} value - A human-readable amount, or a `BN` expressed in whole
 *   tokens (not yet scaled) that will be multiplied by the market's precision
 * @param {SpotMarketAccount} spotMarket - The spot market account (supplies `decimals`)
 * @return {BN} The token amount scaled by `10 ** spotMarket.decimals`
 */
export function castNumberToSpotPrecision(
	value: number | BN,
	spotMarket: SpotMarketAccount
): BN {
	if (typeof value === 'number') {
		return numberToSafeBN(value, new BN(Math.pow(10, spotMarket.decimals)));
	} else {
		return value.mul(new BN(Math.pow(10, spotMarket.decimals)));
	}
}

/**
 * Calculates the effective margin ratio for a spot deposit or borrow position, expressed as
 * `MARGIN_PRECISION - assetWeight` (deposits) or `liabilityWeight - MARGIN_PRECISION` (borrows).
 * Note `MARGIN_PRECISION` and `SPOT_MARKET_WEIGHT_PRECISION` are both 1e4, so weights and margin
 * ratios share the same scale.
 *
 * @param {SpotMarketAccount} market - The spot market account
 * @param {BN} oraclePrice - The oracle price, PRICE_PRECISION (1e6)
 * @param {MarginCategory} marginCategory - `'Initial'` or `'Maintenance'`
 * @param {BN} size - The position size, scaled by `market.decimals`
 * @param {SpotBalanceType} balanceType - Whether `size` is a deposit or a borrow
 * @param {number} [customMarginRatio] - User's custom max margin ratio, `MARGIN_PRECISION` (1e4)
 *   units; only takes effect for `'Initial'`, where the looser (higher) of the computed ratio
 *   and this value is used, so a user can only demand *more* margin than the market default
 * @return {number} The margin ratio, scaled by `MARGIN_PRECISION` (1e4, i.e. 10000 = 100%)
 */
export function calculateSpotMarketMarginRatio(
	market: SpotMarketAccount,
	oraclePrice: BN,
	marginCategory: MarginCategory,
	size: BN,
	balanceType: SpotBalanceType,
	customMarginRatio = 0
): number {
	let marginRatio;

	if (isVariant(balanceType, 'deposit')) {
		const assetWeight = calculateAssetWeight(
			size,
			oraclePrice,
			market,
			marginCategory
		);
		marginRatio = MARGIN_PRECISION.sub(assetWeight).toNumber();
	} else {
		const liabilityWeight = calculateLiabilityWeight(
			size,
			market,
			marginCategory
		);
		marginRatio = liabilityWeight.sub(MARGIN_PRECISION).toNumber();
	}

	if (marginCategory === 'Initial') {
		// use lowest leverage between max allowed and optional user custom max
		return Math.max(marginRatio, customMarginRatio);
	}

	return marginRatio;
}

/**
 * Calculates the remaining room under the spot market's deposit cap, mirroring the check in the
 * program's deposit handler (`deposit_token_amount + amount <= max_token_deposits`, when the cap
 * is set).
 *
 * @param {SpotMarketAccount} market - The spot market account
 * @return {BN} `market.maxTokenDeposits - currentDeposits` (floored at zero), scaled by
 *   `market.decimals`. **Ambiguous zero:** returns `ZERO` both when `maxTokenDeposits === 0`
 *   (cap disabled, deposits are actually unlimited) and when the cap is enabled but already
 *   fully utilized — callers must check `market.maxTokenDeposits.eq(ZERO)` separately to tell
 *   "no limit" from "no room left".
 */
export function calculateMaxRemainingDeposit(market: SpotMarketAccount) {
	const marketMaxTokenDeposits = market.maxTokenDeposits;

	if (marketMaxTokenDeposits.eq(ZERO)) {
		// If the maxTokenDeposits is set to zero then that means there is no limit. Return the largest number we can to represent infinite available deposit.
		return ZERO;
	}

	const totalDepositsTokenAmount = getTokenAmount(
		market.depositBalance,
		market,
		SpotBalanceType.DEPOSIT
	);

	return BN.max(ZERO, marketMaxTokenDeposits.sub(totalDepositsTokenAmount));
}
