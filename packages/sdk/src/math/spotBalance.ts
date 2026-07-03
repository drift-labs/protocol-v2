import {
	SpotMarketAccount,
	SpotBalanceType,
	isVariant,
	MarginCategory,
} from '../types';
import { BN } from '../isomorphic/anchor';
import {
	SPOT_MARKET_UTILIZATION_PRECISION,
	ONE,
	TEN,
	ZERO,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	ONE_YEAR,
	AMM_RESERVE_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
} from '../constants/numericConstants';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';
import { OraclePriceData } from '../oracles/types';
import { PERCENTAGE_PRECISION } from '../constants/numericConstants';
import { divCeil } from './utils';
import { StrictOraclePrice } from '../oracles/strictOraclePrice';

// BN's `.div()` truncates toward zero; the program uses `safe_div_floor` when
// the numerator is negative (get_token_value / get_strict_token_value), so a
// negative dividend must round toward -infinity here to match.
function divFloor(a: BN, b: BN): BN {
	const quotient = a.div(b);
	const remainder = a.mod(b);
	if (!remainder.isZero() && a.isNeg() !== b.isNeg()) {
		return quotient.sub(ONE);
	}
	return quotient;
}

/**
 * Calculates the balance of a given token amount including any accumulated interest. This
 * is the same as `SpotPosition.scaledBalance`.
 *
 * @param {BN} tokenAmount - the amount of tokens
 * @param {SpotMarketAccount} spotMarket - the spot market account
 * @param {SpotBalanceType} balanceType - the balance type ('deposit' or 'borrow')
 * @param {boolean} [roundUp] - override the default rounding direction (program's `round_up`);
 *   defaults to rounding up for borrows only. Callers reducing a deposit balance while the
 *   funds are leaving Velocity (e.g. a withdrawal) should pass `true` to match `is_leaving_velocity`.
 * @return {BN} the calculated balance, scaled by `SPOT_MARKET_BALANCE_PRECISION`
 */
export function getBalance(
	tokenAmount: BN,
	spotMarket: SpotMarketAccount,
	balanceType: SpotBalanceType,
	roundUp?: boolean
): BN {
	const precisionIncrease = TEN.pow(new BN(19 - spotMarket.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? spotMarket.cumulativeDepositInterest
		: spotMarket.cumulativeBorrowInterest;

	let balance = tokenAmount.mul(precisionIncrease).div(cumulativeInterest);

	const shouldRoundUp = roundUp ?? isVariant(balanceType, 'borrow');
	if (!balance.eq(ZERO) && shouldRoundUp) {
		balance = balance.add(ONE);
	}

	return balance;
}

/**
 * Calculates the spot token amount including any accumulated interest.
 *
 * @param {BN} balanceAmount - The balance amount, typically from `SpotPosition.scaledBalance`
 * @param {SpotMarketAccount} spotMarket - The spot market account details
 * @param {SpotBalanceType} balanceType - The balance type to be used for calculation
 * @returns {BN} The calculated token amount, scaled by `SpotMarketConfig.precision`
 */
export function getTokenAmount(
	balanceAmount: BN,
	spotMarket: SpotMarketAccount,
	balanceType: SpotBalanceType
): BN {
	const precisionDecrease = TEN.pow(new BN(19 - spotMarket.decimals));
	if (isVariant(balanceType, 'deposit')) {
		return balanceAmount
			.mul(spotMarket.cumulativeDepositInterest)
			.div(precisionDecrease);
	} else {
		return divCeil(
			balanceAmount.mul(spotMarket.cumulativeBorrowInterest),
			precisionDecrease
		);
	}
}

/**
 * Returns the signed (positive for deposit,negative for borrow) token amount based on the balance type.
 *
 * @param {BN} tokenAmount - The token amount to convert (from `getTokenAmount`)
 * @param {SpotBalanceType} balanceType - The balance type to determine the sign of the token amount.
 * @returns {BN} - The signed token amount, scaled by `SpotMarketConfig.precision`
 */
export function getSignedTokenAmount(
	tokenAmount: BN,
	balanceType: SpotBalanceType
): BN {
	if (isVariant(balanceType, 'deposit')) {
		return tokenAmount;
	} else {
		return tokenAmount.abs().neg();
	}
}

/**
 * Calculates the value of a given token amount using the worst of the provided oracle price and its TWAP.
 *
 * @param {BN} tokenAmount - The amount of tokens to calculate the value for (from `getTokenAmount`)
 * @param {number} spotDecimals - The number of decimals in the token.
 * @param {StrictOraclePrice} strictOraclePrice - Contains oracle price and 5min twap.
 * @return {BN} The calculated value of the given token amount, scaled by `PRICE_PRECISION`
 */
export function getStrictTokenValue(
	tokenAmount: BN,
	spotDecimals: number,
	strictOraclePrice: StrictOraclePrice
): BN {
	if (tokenAmount.eq(ZERO)) {
		return ZERO;
	}

	let price;
	if (tokenAmount.gte(ZERO)) {
		price = strictOraclePrice.min();
	} else {
		price = strictOraclePrice.max();
	}

	const precisionDecrease = TEN.pow(new BN(spotDecimals));
	const tokenWithPrice = tokenAmount.mul(price);

	if (tokenWithPrice.isNeg()) {
		return divFloor(tokenWithPrice, precisionDecrease);
	}
	return tokenWithPrice.div(precisionDecrease);
}

/**
 * Calculates the value of a given token amount in relation to an oracle price data
 *
 * @param {BN} tokenAmount - The amount of tokens to calculate the value for (from `getTokenAmount`)
 * @param {number} spotDecimals - The number of decimal places of the token.
 * @param {OraclePriceData} oraclePriceData - The oracle price data (typically a token/USD oracle).
 * @return {BN} The value of the token based on the oracle, scaled by `PRICE_PRECISION`
 */
export function getTokenValue(
	tokenAmount: BN,
	spotDecimals: number,
	oraclePriceData: Pick<OraclePriceData, 'price'>
): BN {
	if (tokenAmount.eq(ZERO)) {
		return ZERO;
	}

	const precisionDecrease = TEN.pow(new BN(spotDecimals));
	const tokenWithOraclePrice = tokenAmount.mul(oraclePriceData.price);

	if (tokenWithOraclePrice.isNeg()) {
		return divFloor(tokenWithOraclePrice, precisionDecrease);
	}
	return tokenWithOraclePrice.div(precisionDecrease);
}

/**
 * Calculates the collateral (asset) weight applied to a spot deposit balance, mirroring
 * `SpotMarket::get_asset_weight`'s `Initial`/`Maintenance` branches (there is no SDK
 * equivalent of the on-chain `Fill` branch, which averages initial and maintenance).
 * Size is first rescaled into `AMM_RESERVE_PRECISION` before the IMF size-discount is applied,
 * so larger positions receive a lower (more conservative) weight.
 *
 * @param {BN} balanceAmount - The deposit token amount, scaled by the spot market's token decimals
 * @param {BN} oraclePrice - The oracle price, PRICE_PRECISION (1e6); only used for the `Initial`
 *   scaled-weight lookup (`calculateScaledInitialAssetWeight`)
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @param {MarginCategory | undefined} marginCategory - `'Initial'`, `'Maintenance'`, `'Fill'`
 *   (the integer-averaged midpoint of scaled-initial and maintenance weights), or `undefined`
 *   (defaults to the scaled initial weight, used for e.g. UI display outside a margin check)
 * @return {BN} The asset weight, scaled by `SPOT_MARKET_WEIGHT_PRECISION` (1e4, i.e. 10000 = 100%)
 */
export function calculateAssetWeight(
	balanceAmount: BN,
	oraclePrice: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory | undefined
): BN {
	const sizePrecision = TEN.pow(new BN(spotMarket.decimals));
	let sizeInAmmReservePrecision;
	if (sizePrecision.gt(AMM_RESERVE_PRECISION)) {
		sizeInAmmReservePrecision = balanceAmount.div(
			sizePrecision.div(AMM_RESERVE_PRECISION)
		);
	} else {
		sizeInAmmReservePrecision = balanceAmount
			.mul(AMM_RESERVE_PRECISION)
			.div(sizePrecision);
	}

	let assetWeight;

	switch (marginCategory) {
		case 'Initial':
			assetWeight = calculateSizeDiscountAssetWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				calculateScaledInitialAssetWeight(spotMarket, oraclePrice)
			);
			break;
		case 'Fill':
			// mirrors SpotMarket::get_asset_weight's Fill branch:
			// (scaled_initial_asset_weight + maintenance_asset_weight) / 2 (integer division)
			assetWeight = calculateSizeDiscountAssetWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				calculateScaledInitialAssetWeight(spotMarket, oraclePrice)
					.add(new BN(spotMarket.maintenanceAssetWeight))
					.divn(2)
			);
			break;
		case 'Maintenance':
			assetWeight = calculateSizeDiscountAssetWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.maintenanceAssetWeight)
			);
			break;
		default:
			assetWeight = calculateScaledInitialAssetWeight(spotMarket, oraclePrice);
			break;
	}

	return assetWeight;
}

/**
 * Calculates the initial asset weight after applying the market's optional deposit-value
 * scaling, mirroring `SpotMarket::get_scaled_initial_asset_weight`. When
 * `scaleInitialAssetWeightStart` is set and total deposit value exceeds it, the weight is
 * scaled down proportionally (`initialAssetWeight * scaleInitialAssetWeightStart / depositsValue`)
 * so the market's collateral usefulness degrades as its deposits grow past the configured cap.
 *
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @param {BN} oraclePrice - The oracle price, PRICE_PRECISION (1e6), used to value total deposits
 * @return {BN} The (possibly scaled) initial asset weight, `SPOT_MARKET_WEIGHT_PRECISION` (1e4)
 */
export function calculateScaledInitialAssetWeight(
	spotMarket: SpotMarketAccount,
	oraclePrice: BN
): BN {
	if (spotMarket.scaleInitialAssetWeightStart.eq(ZERO)) {
		return new BN(spotMarket.initialAssetWeight);
	}

	const deposits = getTokenAmount(
		spotMarket.depositBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	const depositsValue = getTokenValue(deposits, spotMarket.decimals, {
		price: oraclePrice,
	});

	if (depositsValue.lt(spotMarket.scaleInitialAssetWeightStart)) {
		return new BN(spotMarket.initialAssetWeight);
	} else {
		return new BN(spotMarket.initialAssetWeight)
			.mul(spotMarket.scaleInitialAssetWeightStart)
			.div(depositsValue);
	}
}

/**
 * Calculates the liability (borrow) weight applied to a spot borrow balance, mirroring
 * `SpotMarket::get_liability_weight`'s `Initial`/`Maintenance` branches. Size is rescaled into
 * `AMM_RESERVE_PRECISION` before the IMF size-premium is applied, so larger borrows receive a
 * higher (more conservative) weight.
 *
 * @param {BN} size - The borrow token amount, scaled by the spot market's token decimals
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @param {MarginCategory | undefined} marginCategory - `'Initial'`, `'Maintenance'`, `'Fill'`
 *   (the integer-averaged midpoint of initial and maintenance liability weights), or
 *   `undefined` (defaults to `initialLiabilityWeight` with no size premium applied)
 * @return {BN} The liability weight, scaled by `SPOT_MARKET_WEIGHT_PRECISION` (1e4, i.e. 10000 = 100%)
 */
export function calculateLiabilityWeight(
	size: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory | undefined
): BN {
	const sizePrecision = TEN.pow(new BN(spotMarket.decimals));
	let sizeInAmmReservePrecision;
	if (sizePrecision.gt(AMM_RESERVE_PRECISION)) {
		sizeInAmmReservePrecision = size.div(
			sizePrecision.div(AMM_RESERVE_PRECISION)
		);
	} else {
		sizeInAmmReservePrecision = size
			.mul(AMM_RESERVE_PRECISION)
			.div(sizePrecision);
	}

	let liabilityWeight;

	switch (marginCategory) {
		case 'Initial':
			liabilityWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.initialLiabilityWeight),
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		case 'Fill':
			// mirrors SpotMarket::get_liability_weight's Fill branch:
			// (initial_liability_weight + maintenance_liability_weight) / 2 (integer division)
			liabilityWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.initialLiabilityWeight)
					.add(new BN(spotMarket.maintenanceLiabilityWeight))
					.divn(2),
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		case 'Maintenance':
			liabilityWeight = calculateSizePremiumLiabilityWeight(
				sizeInAmmReservePrecision,
				new BN(spotMarket.imfFactor),
				new BN(spotMarket.maintenanceLiabilityWeight),
				SPOT_MARKET_WEIGHT_PRECISION
			);
			break;
		default:
			liabilityWeight = new BN(spotMarket.initialLiabilityWeight);
			break;
	}

	return liabilityWeight;
}

/**
 * Calculates a spot market's utilization (borrows / deposits), mirroring
 * `calculate_utilization`. Returns `SPOT_MARKET_UTILIZATION_PRECISION` (100% utilization) if
 * there are borrows but no deposits, and zero if both are zero.
 *
 * @param {SpotMarketAccount} bank - The spot market account
 * @param {BN} [delta] - Optional hypothetical change in token amount, scaled by the market's
 *   token decimals: a positive delta is added to deposits, a negative delta (its absolute
 *   value) is added to borrows. Defaults to zero (current on-chain utilization).
 * @return {BN} Utilization, scaled by `SPOT_MARKET_UTILIZATION_PRECISION` (1e6, i.e. 1e6 = 100%)
 */
export function calculateUtilization(
	bank: SpotMarketAccount,
	delta = ZERO
): BN {
	let tokenDepositAmount = getTokenAmount(
		bank.depositBalance,
		bank,
		SpotBalanceType.DEPOSIT
	);
	let tokenBorrowAmount = getTokenAmount(
		bank.borrowBalance,
		bank,
		SpotBalanceType.BORROW
	);

	if (delta.gt(ZERO)) {
		tokenDepositAmount = tokenDepositAmount.add(delta);
	} else if (delta.lt(ZERO)) {
		tokenBorrowAmount = tokenBorrowAmount.add(delta.abs());
	}

	let utilization: BN;
	if (tokenBorrowAmount.eq(ZERO) && tokenDepositAmount.eq(ZERO)) {
		utilization = ZERO;
	} else if (tokenDepositAmount.eq(ZERO)) {
		utilization = SPOT_MARKET_UTILIZATION_PRECISION;
	} else {
		utilization = tokenBorrowAmount
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(tokenDepositAmount);
	}

	return utilization;
}

/**
 * SDK-only helper (no direct on-chain counterpart) that inverts `calculateInterestRate`'s
 * utilization curve to find how much more can be borrowed before the borrow rate would reach
 * `targetBorrowRate`. Useful for UI "available to borrow at rate X" displays.
 *
 * @param {SpotMarketAccount} spotMarketAccount - The spot market account
 * @param {BN} targetBorrowRate - The target annualized borrow rate, `SPOT_MARKET_RATE_PRECISION` (1e6)
 * @returns {{ totalCapacity: BN; remainingCapacity: BN }} Both scaled by the market's token
 *   decimals. `totalCapacity` is the total borrow amount implied by the target utilization;
 *   `remainingCapacity` is `totalCapacity` minus current borrows (zero if the market's current
 *   borrow rate already meets or exceeds the target), additionally capped by
 *   `maxTokenBorrowsFraction` of `maxTokenDeposits` when that cap is configured (>0)
 */
export function calculateSpotMarketBorrowCapacity(
	spotMarketAccount: SpotMarketAccount,
	targetBorrowRate: BN
): { totalCapacity: BN; remainingCapacity: BN } {
	const currentBorrowRate = calculateBorrowRate(spotMarketAccount);

	const tokenDepositAmount = getTokenAmount(
		spotMarketAccount.depositBalance,
		spotMarketAccount,
		SpotBalanceType.DEPOSIT
	);

	const tokenBorrowAmount = getTokenAmount(
		spotMarketAccount.borrowBalance,
		spotMarketAccount,
		SpotBalanceType.BORROW
	);

	let targetUtilization;
	// target utilization past mid point
	if (targetBorrowRate.gte(new BN(spotMarketAccount.optimalBorrowRate))) {
		const borrowRateSlope = new BN(
			spotMarketAccount.maxBorrowRate - spotMarketAccount.optimalBorrowRate
		)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(
				SPOT_MARKET_UTILIZATION_PRECISION.sub(
					new BN(spotMarketAccount.optimalUtilization)
				)
			);

		const surplusTargetUtilization = targetBorrowRate
			.sub(new BN(spotMarketAccount.optimalBorrowRate))
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(borrowRateSlope);

		targetUtilization = surplusTargetUtilization.add(
			new BN(spotMarketAccount.optimalUtilization)
		);
	} else {
		const borrowRateSlope = new BN(spotMarketAccount.optimalBorrowRate)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(new BN(spotMarketAccount.optimalUtilization));

		targetUtilization = targetBorrowRate
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(borrowRateSlope);
	}

	const totalCapacity = tokenDepositAmount
		.mul(targetUtilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION);

	let remainingCapacity;
	if (currentBorrowRate.gte(targetBorrowRate)) {
		remainingCapacity = ZERO;
	} else {
		remainingCapacity = BN.max(ZERO, totalCapacity.sub(tokenBorrowAmount));
	}

	if (spotMarketAccount.maxTokenBorrowsFraction > 0) {
		const maxTokenBorrows = spotMarketAccount.maxTokenDeposits
			.mul(new BN(spotMarketAccount.maxTokenBorrowsFraction))
			.divn(10000);

		remainingCapacity = BN.min(
			remainingCapacity,
			BN.max(ZERO, maxTokenBorrows.sub(tokenBorrowAmount))
		);
	}

	return { totalCapacity, remainingCapacity };
}

/**
 * Calculates the annualized borrow interest rate for a spot market, mirroring
 * `calculate_borrow_rate` / the underlying utilization curve. Below `optimalUtilization` the
 * rate ramps linearly from 0 to `optimalBorrowRate`; above it, the rate ramps through a fixed
 * piecewise schedule (85/90/95/99/99.5/100% utilization breakpoints) from `optimalBorrowRate`
 * up to `maxBorrowRate`. The result is floored at `minBorrowRate / 200` (i.e. `minBorrowRate`
 * is in units of half-percentage-points of `PERCENTAGE_PRECISION`).
 *
 * @param {SpotMarketAccount} bank - The spot market account
 * @param {BN} [delta] - Optional hypothetical change in token amount passed through to
 *   `calculateUtilization` (ignored if `currentUtilization` is provided)
 * @param {BN} [currentUtilization] - Precomputed utilization, `SPOT_MARKET_UTILIZATION_PRECISION`
 *   (1e6); if omitted it is derived from `bank` and `delta`
 * @return {BN} Annualized borrow rate, scaled by `SPOT_MARKET_RATE_PRECISION` (1e6)
 */
export function calculateInterestRate(
	bank: SpotMarketAccount,
	delta = ZERO,
	currentUtilization?: BN
): BN {
	// todo: ensure both a delta and current util aren't pass?
	const utilization = currentUtilization ?? calculateUtilization(bank, delta);

	const optimalUtil = new BN(bank.optimalUtilization);
	const optimalRate = new BN(bank.optimalBorrowRate);
	const maxRate = new BN(bank.maxBorrowRate);
	const minRate = new BN(bank.minBorrowRate).mul(
		PERCENTAGE_PRECISION.divn(200)
	);

	const weightsDivisor = new BN(1000);
	const segments: [BN, BN][] = [
		[new BN(850_000), new BN(50)],
		[new BN(900_000), new BN(100)],
		[new BN(950_000), new BN(150)],
		[new BN(990_000), new BN(200)],
		[new BN(995_000), new BN(250)],
		[SPOT_MARKET_UTILIZATION_PRECISION, new BN(250)],
	];

	let rate: BN;
	if (utilization.lte(optimalUtil)) {
		// below optimal: linear ramp from 0 to optimalRate
		const slope = optimalRate
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(optimalUtil);
		rate = utilization.mul(slope).div(SPOT_MARKET_UTILIZATION_PRECISION);
	} else {
		// above optimal: piecewise segments
		const totalExtraRate = maxRate.sub(optimalRate);

		rate = optimalRate.clone();
		let prevUtil = optimalUtil.clone();

		for (const [bp, weight] of segments) {
			const segmentEnd = bp.gt(SPOT_MARKET_UTILIZATION_PRECISION)
				? SPOT_MARKET_UTILIZATION_PRECISION
				: bp;
			const segmentRange = segmentEnd.sub(prevUtil);

			const segmentRateTotal = totalExtraRate.mul(weight).div(weightsDivisor);

			if (utilization.lte(segmentEnd)) {
				const partialUtil = utilization.sub(prevUtil);
				const partialRate = segmentRateTotal.mul(partialUtil).div(segmentRange);
				rate = rate.add(partialRate);
				break;
			} else {
				rate = rate.add(segmentRateTotal);
				prevUtil = segmentEnd;
			}
		}
	}

	return BN.max(minRate, rate);
}

/**
 * Calculates the annualized deposit interest rate for a spot market, mirroring
 * `calculate_deposit_rate` (velocity-rs). Lenders receive the borrow rate net of the insurance
 * fund and protocol fee carveouts (`ifFeeFactor` + `protocolFeeFactor`, both `PERCENTAGE_PRECISION`),
 * scaled down by utilization since only borrowed deposits earn interest.
 *
 * @param {SpotMarketAccount} bank - The spot market account
 * @param {BN} [delta] - Optional hypothetical change in token amount; positive adds to deposits,
 *   negative adds to borrows (see `calculateUtilization`)
 * @param {BN} [currentUtilization] - Precomputed utilization, `SPOT_MARKET_UTILIZATION_PRECISION`
 *   (1e6); if omitted it is derived from `bank` and `delta`
 * @return {BN} Annualized deposit rate, scaled by `SPOT_MARKET_RATE_PRECISION` (1e6)
 */
export function calculateDepositRate(
	bank: SpotMarketAccount,
	delta = ZERO,
	currentUtilization?: BN
): BN {
	// positive delta => adding to deposit
	// negative delta => adding to borrow

	const utilization = currentUtilization ?? calculateUtilization(bank, delta);
	const borrowRate = calculateBorrowRate(bank, delta, utilization);
	const depositRate = borrowRate
		.mul(
			PERCENTAGE_PRECISION.sub(
				new BN(bank.insuranceFund.ifFeeFactor + bank.protocolFeeFactor)
			)
		)
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION)
		.div(PERCENTAGE_PRECISION);
	return depositRate;
}

/**
 * Alias for `calculateInterestRate` (annualized borrow rate).
 *
 * @param {SpotMarketAccount} bank - The spot market account
 * @param {BN} [delta] - Optional hypothetical change in token amount (see `calculateUtilization`)
 * @param {BN} [currentUtilization] - Precomputed utilization, `SPOT_MARKET_UTILIZATION_PRECISION` (1e6)
 * @return {BN} Annualized borrow rate, scaled by `SPOT_MARKET_RATE_PRECISION` (1e6)
 */
export function calculateBorrowRate(
	bank: SpotMarketAccount,
	delta = ZERO,
	currentUtilization?: BN
): BN {
	return calculateInterestRate(bank, delta, currentUtilization);
}

/**
 * Projects the cumulative interest multipliers that would accrue between `spotMarket.lastInterestTs`
 * and `now` at the market's current interest rate, mirroring the gross amounts computed by
 * `calculate_accumulated_interest`. This is a point-in-time estimate for display purposes only —
 * the actual on-chain update (`update_spot_market_cumulative_interest`) re-derives the rate from
 * utilization at settlement time (same as this function calling `calculateInterestRate(bank)` with
 * no delta), and only runs at all if `deposit_interest > 0 && borrow_interest > 1`. Borrow interest
 * is always rounded up by 1 (added unconditionally), matching the program's lender-favoring
 * rounding, and is credited to `cumulativeBorrowInterest` in full. **`depositInterest` here is the
 * gross pre-carveout amount** — on-chain, `insuranceFund.ifFeeFactor` and `protocolFeeFactor`
 * (both `IF_FACTOR_PRECISION`) are each cut from it first (to `revenuePool` and `protocolFeePool`
 * respectively) and only the remainder is what actually gets added to `cumulativeDepositInterest`;
 * this function does not replicate that split, so it overstates the deposit-side increment
 * whenever either factor is non-zero.
 *
 * @param {SpotMarketAccount} bank - The spot market account
 * @param {BN} now - The timestamp (unix seconds) to project interest up to
 * @return {{ borrowInterest: BN; depositInterest: BN }} `borrowInterest` is the exact amount added
 *   to `cumulativeBorrowInterest`; `depositInterest` is the gross pre-carveout amount, not
 *   necessarily what's added to `cumulativeDepositInterest` (see above). Both in the same
 *   fixed-point units as those cumulative fields (`SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION`)
 */
export function calculateInterestAccumulated(
	bank: SpotMarketAccount,
	now: BN
): { borrowInterest: BN; depositInterest: BN } {
	const interestRate = calculateInterestRate(bank);

	const timeSinceLastUpdate = now.sub(bank.lastInterestTs);

	const modifiedBorrowRate = interestRate.mul(timeSinceLastUpdate);

	const utilization = calculateUtilization(bank);

	const modifiedDepositRate = modifiedBorrowRate
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION);

	const borrowInterest = bank.cumulativeBorrowInterest
		.mul(modifiedBorrowRate)
		.div(ONE_YEAR)
		.div(SPOT_MARKET_RATE_PRECISION)
		.add(ONE);
	const depositInterest = bank.cumulativeDepositInterest
		.mul(modifiedDepositRate)
		.div(ONE_YEAR)
		.div(SPOT_MARKET_RATE_PRECISION);

	return { borrowInterest, depositInterest };
}

/**
 * Calculates the minimum deposit / maximum borrow token amounts that keep the market's
 * utilization from exceeding a "max withdraw utilization" ceiling, mirroring
 * `calculate_token_utilization_limits`. The ceiling is `max(optimalUtilization,
 * utilizationTwap + (100% - utilizationTwap) / 2)` — i.e. it allows utilization to rise, but
 * only up to halfway from the TWAP to 100%. Deposit sizes already below
 * `withdrawGuardThreshold` are never blocked (the min-deposit result is capped so it can't
 * exceed `depositTokenAmount - withdrawGuardThreshold`), and borrows below the guard threshold
 * are never blocked either (the max-borrow result is floored at `withdrawGuardThreshold`).
 *
 * @param {BN} depositTokenAmount - Current total deposit token amount, market's token decimals
 * @param {BN} borrowTokenAmount - Current total borrow token amount, market's token decimals
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @return {{ minDepositTokensForUtilization: BN; maxBorrowTokensForUtilization: BN }} Both
 *   scaled by the market's token decimals
 */
export function calculateTokenUtilizationLimits(
	depositTokenAmount: BN,
	borrowTokenAmount: BN,
	spotMarket: SpotMarketAccount
): {
	minDepositTokensForUtilization: BN;
	maxBorrowTokensForUtilization: BN;
} {
	// Calculates the allowable minimum deposit and maximum borrow amounts for immediate withdrawal based on market utilization.
	// First, it determines a maximum withdrawal utilization from the market's target and historic utilization.
	// Then, it deduces corresponding deposit/borrow amounts.
	// Note: For deposit sizes below the guard threshold, withdrawals aren't blocked.

	const maxWithdrawUtilization = BN.max(
		new BN(spotMarket.optimalUtilization),
		spotMarket.utilizationTwap.add(
			SPOT_MARKET_UTILIZATION_PRECISION.sub(spotMarket.utilizationTwap).div(
				new BN(2)
			)
		)
	);

	let minDepositTokensForUtilization = borrowTokenAmount
		.mul(SPOT_MARKET_UTILIZATION_PRECISION)
		.div(maxWithdrawUtilization);

	// don't block withdraws for deposit sizes below guard threshold
	minDepositTokensForUtilization = BN.min(
		minDepositTokensForUtilization,
		depositTokenAmount.sub(spotMarket.withdrawGuardThreshold)
	);

	let maxBorrowTokensForUtilization = maxWithdrawUtilization
		.mul(depositTokenAmount)
		.div(SPOT_MARKET_UTILIZATION_PRECISION);

	maxBorrowTokensForUtilization = BN.max(
		spotMarket.withdrawGuardThreshold,
		maxBorrowTokensForUtilization
	);

	return {
		minDepositTokensForUtilization,
		maxBorrowTokensForUtilization,
	};
}

/**
 * Estimates the current immediate withdraw/borrow limits for a spot market, mirroring the
 * on-chain `check_withdraw_limits` / `get_max_withdraw_for_market_with_token_amount` guard
 * (combining `calculate_min_deposit_token_amount`, `calculate_max_borrow_token_amount`, and
 * `calculateTokenUtilizationLimits`). Because the SDK cannot force an on-chain TWAP update
 * before reading it, this projects a "live" 24h deposit/borrow TWAP by weighting the stored
 * TWAP and the current amount by `sinceStart`/`sinceLast` (the same weighted-average shape as
 * `update_spot_market_twap_stats`, without its rounding bias term) before deriving limits, so
 * the result approximates what the on-chain TWAP would be if updated at `now`.
 *
 * Deposit/borrow TWAP friction bands differ by pool: the main pool (`poolId === 0`) targets
 * ~30-92.5% utilization (borrow ceiling is `lesserDepositAmount` clamped between 1/3 and
 * 13/14 of itself, floored around the live borrow TWAP + 1/5), isolated pools (`poolId !== 0`)
 * target ~50-95% (clamped between 1/2 and 19/20, floored around the live borrow TWAP + 1/3).
 * `lesserDepositAmount` is `min(currentDepositAmount, live deposit TWAP)` — using the smaller of
 * the two keeps the borrow ceiling conservative whether deposits are rising or falling.
 * `borrowLimit` is additionally zeroed for `assetTier === 'protected'` markets, and both limits
 * are clamped by `maxTokenBorrowsFraction` of `maxTokenDeposits` when that cap is configured.
 *
 * @param {SpotMarketAccount} spotMarket - The spot market account
 * @param {BN} now - The timestamp (unix seconds) to project the live TWAP up to
 * @return {{ borrowLimit: BN; withdrawLimit: BN; minDepositAmount: BN; maxBorrowAmount: BN;
 *   currentDepositAmount: BN; currentBorrowAmount: BN }} All values scaled by the market's token
 *   decimals. `withdrawLimit`/`borrowLimit` are floored at zero (a market already past its
 *   min-deposit/max-borrow bound reports zero remaining room rather than negative)
 */
export function calculateWithdrawLimit(
	spotMarket: SpotMarketAccount,
	now: BN
): {
	borrowLimit: BN;
	withdrawLimit: BN;
	minDepositAmount: BN;
	maxBorrowAmount: BN;
	currentDepositAmount: BN;
	currentBorrowAmount: BN;
} {
	const marketDepositTokenAmount = getTokenAmount(
		spotMarket.depositBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	const marketBorrowTokenAmount = getTokenAmount(
		spotMarket.borrowBalance,
		spotMarket,
		SpotBalanceType.BORROW
	);

	const twentyFourHours = new BN(60 * 60 * 24);
	const sinceLast = now.sub(spotMarket.lastTwapTs);
	const sinceStart = BN.max(ZERO, twentyFourHours.sub(sinceLast));
	const borrowTokenTwapLive = spotMarket.borrowTokenTwap
		.mul(sinceStart)
		.add(marketBorrowTokenAmount.mul(sinceLast))
		.div(sinceLast.add(sinceStart));

	const depositTokenTwapLive = spotMarket.depositTokenTwap
		.mul(sinceStart)
		.add(marketDepositTokenAmount.mul(sinceLast))
		.div(sinceLast.add(sinceStart));

	const lesserDepositAmount = BN.min(
		marketDepositTokenAmount,
		depositTokenTwapLive
	);
	let maxBorrowTokensTwap;

	if (spotMarket.poolId == 0) {
		maxBorrowTokensTwap = BN.max(
			spotMarket.withdrawGuardThreshold,
			BN.min(
				BN.max(
					lesserDepositAmount.div(new BN(3)),
					borrowTokenTwapLive.add(lesserDepositAmount.div(new BN(5)))
				),
				lesserDepositAmount.sub(lesserDepositAmount.div(new BN(14)))
			)
		); // main pool between ~30-92.5% utilization with friction on twap in 20% increments
	} else {
		maxBorrowTokensTwap = BN.max(
			spotMarket.withdrawGuardThreshold,
			BN.min(
				BN.max(
					lesserDepositAmount.div(new BN(2)),
					borrowTokenTwapLive.add(lesserDepositAmount.div(new BN(3)))
				),
				lesserDepositAmount.sub(lesserDepositAmount.div(new BN(20)))
			)
		); // isolated pools between 50-95% utilization with friction on twap in 33% increments
	}

	const minDepositTokensTwap = depositTokenTwapLive.sub(
		BN.max(
			depositTokenTwapLive.div(new BN(4)),
			BN.min(spotMarket.withdrawGuardThreshold, depositTokenTwapLive)
		)
	);

	const { minDepositTokensForUtilization, maxBorrowTokensForUtilization } =
		calculateTokenUtilizationLimits(
			marketDepositTokenAmount,
			marketBorrowTokenAmount,
			spotMarket
		);

	const minDepositTokens = BN.max(
		minDepositTokensForUtilization,
		minDepositTokensTwap
	);

	let maxBorrowTokens = BN.min(
		maxBorrowTokensForUtilization,
		maxBorrowTokensTwap
	);

	const withdrawLimit = BN.max(
		marketDepositTokenAmount.sub(minDepositTokens),
		ZERO
	);

	let borrowLimit = maxBorrowTokens.sub(marketBorrowTokenAmount);

	borrowLimit = BN.min(
		borrowLimit,
		marketDepositTokenAmount.sub(marketBorrowTokenAmount)
	);

	if (spotMarket.maxTokenBorrowsFraction > 0) {
		const maxTokenBorrowsByFraction = spotMarket.maxTokenDeposits
			.mul(new BN(spotMarket.maxTokenBorrowsFraction))
			.divn(10000);

		const trueMaxBorrowTokensAvailable = maxTokenBorrowsByFraction.sub(
			marketBorrowTokenAmount
		);

		maxBorrowTokens = BN.min(maxBorrowTokens, trueMaxBorrowTokensAvailable);

		borrowLimit = BN.min(borrowLimit, maxBorrowTokens);
	}

	if (withdrawLimit.eq(ZERO) || isVariant(spotMarket.assetTier, 'protected')) {
		borrowLimit = ZERO;
	}

	return {
		borrowLimit,
		withdrawLimit,
		maxBorrowAmount: maxBorrowTokens,
		minDepositAmount: minDepositTokens,
		currentDepositAmount: marketDepositTokenAmount,
		currentBorrowAmount: marketBorrowTokenAmount,
	};
}

/**
 * Calculates the margin-weighted value of a spot deposit, mirroring the asset-side of the
 * program's collateral valuation (`get_strict_token_value` + `get_asset_weight`). Uses the
 * worst of the oracle's live price and its 5min TWAP (via `strictOraclePrice`) so a favorable
 * price spike can't be used to over-value collateral.
 *
 * @param {BN} tokenAmount - The deposit token amount, scaled by `spotMarketAccount.decimals`
 * @param {StrictOraclePrice} strictOraclePrice - Live oracle price + 5min TWAP, PRICE_PRECISION (1e6)
 * @param {SpotMarketAccount} spotMarketAccount - The spot market account
 * @param {number} maxMarginRatio - The user's custom max margin ratio (0 if unset), in
 *   `SPOT_MARKET_WEIGHT_PRECISION` (1e4) units; only applied when `marginCategory === 'Initial'`
 *   and the market isn't the quote spot market, capping the weight at
 *   `SPOT_MARKET_WEIGHT_PRECISION - maxMarginRatio`
 * @param {MarginCategory} [marginCategory] - When omitted, returns the unweighted (100%) value
 * @return {BN} The (optionally weighted) asset value, scaled by `PRICE_PRECISION` (1e6)
 */
export function getSpotAssetValue(
	tokenAmount: BN,
	strictOraclePrice: StrictOraclePrice,
	spotMarketAccount: SpotMarketAccount,
	maxMarginRatio: number,
	marginCategory?: MarginCategory
): BN {
	let assetValue = getStrictTokenValue(
		tokenAmount,
		spotMarketAccount.decimals,
		strictOraclePrice
	);

	if (marginCategory !== undefined) {
		let weight = calculateAssetWeight(
			tokenAmount,
			strictOraclePrice.current,
			spotMarketAccount,
			marginCategory
		);

		if (
			marginCategory === 'Initial' &&
			spotMarketAccount.marketIndex !== QUOTE_SPOT_MARKET_INDEX
		) {
			const userCustomAssetWeight = BN.max(
				ZERO,
				SPOT_MARKET_WEIGHT_PRECISION.sub(new BN(maxMarginRatio))
			);
			weight = BN.min(weight, userCustomAssetWeight);
		}

		assetValue = assetValue.mul(weight).div(SPOT_MARKET_WEIGHT_PRECISION);
	}

	return assetValue;
}

/**
 * Calculates the margin-weighted value of a spot borrow, mirroring the liability-side of the
 * program's collateral valuation (`get_strict_token_value` + `get_liability_weight`). Uses the
 * worst of the oracle's live price and its 5min TWAP (via `strictOraclePrice`) so a favorable
 * price dip can't be used to under-value a liability.
 *
 * @param {BN} tokenAmount - The borrow token amount (positive), scaled by `spotMarketAccount.decimals`
 * @param {StrictOraclePrice} strictOraclePrice - Live oracle price + 5min TWAP, PRICE_PRECISION (1e6)
 * @param {SpotMarketAccount} spotMarketAccount - The spot market account
 * @param {number} maxMarginRatio - The user's custom max margin ratio (0 if unset),
 *   `SPOT_MARKET_WEIGHT_PRECISION` (1e4) units; only applied when `marginCategory === 'Initial'`
 *   and the market isn't the quote spot market, flooring the weight at
 *   `SPOT_MARKET_WEIGHT_PRECISION + maxMarginRatio`
 * @param {MarginCategory} [marginCategory] - When omitted, returns the unweighted (100%) value
 * @param {BN} [liquidationBuffer] - Extra weight added on top (`SPOT_MARKET_WEIGHT_PRECISION`
 *   units) to make maintenance margin checks stricter during liquidation eligibility checks
 * @return {BN} The (optionally weighted) liability value, scaled by `PRICE_PRECISION` (1e6)
 */
export function getSpotLiabilityValue(
	tokenAmount: BN,
	strictOraclePrice: StrictOraclePrice,
	spotMarketAccount: SpotMarketAccount,
	maxMarginRatio: number,
	marginCategory?: MarginCategory,
	liquidationBuffer?: BN
): BN {
	let liabilityValue = getStrictTokenValue(
		tokenAmount,
		spotMarketAccount.decimals,
		strictOraclePrice
	);

	if (marginCategory !== undefined) {
		let weight = calculateLiabilityWeight(
			tokenAmount,
			spotMarketAccount,
			marginCategory
		);

		if (
			marginCategory === 'Initial' &&
			spotMarketAccount.marketIndex !== QUOTE_SPOT_MARKET_INDEX
		) {
			weight = BN.max(
				weight,
				SPOT_MARKET_WEIGHT_PRECISION.add(new BN(maxMarginRatio))
			);
		}

		if (liquidationBuffer !== undefined) {
			weight = weight.add(liquidationBuffer);
		}

		liabilityValue = liabilityValue
			.mul(weight)
			.div(SPOT_MARKET_WEIGHT_PRECISION);
	}

	return liabilityValue;
}
