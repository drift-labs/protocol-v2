import {
	SpotMarketAccount,
	SpotBalanceType,
	isVariant,
	MarginCategory,
} from '../types';
import { BN } from '@coral-xyz/anchor';
import {
	SPOT_MARKET_UTILIZATION_PRECISION,
	ONE,
	TEN,
	ZERO,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	ONE_YEAR,
	AMM_RESERVE_PRECISION,
} from '../constants/numericConstants';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';
import { OraclePriceData } from '../oracles/types';
import { PERCENTAGE_PRECISION } from '../constants/numericConstants';
import { divCeil } from './utils';
import { StrictOraclePrice } from '../oracles/strictOraclePrice';

/**
 * Calculates the balance of a given token amount including any accumulated interest. This
 * is the same as `SpotPosition.scaledBalance`.
 *
 * @param {BN} tokenAmount - the amount of tokens
 * @param {SpotMarketAccount} spotMarket - the spot market account
 * @param {SpotBalanceType} balanceType - the balance type ('deposit' or 'borrow')
 * @return {BN} the calculated balance, scaled by `SPOT_MARKET_BALANCE_PRECISION`
 */
export function getBalance(
	tokenAmount: BN,
	spotMarket: SpotMarketAccount,
	balanceType: SpotBalanceType
): BN {
	const precisionIncrease = TEN.pow(new BN(19 - spotMarket.decimals));

	const cumulativeInterest = isVariant(balanceType, 'deposit')
		? spotMarket.cumulativeDepositInterest
		: spotMarket.cumulativeBorrowInterest;

	let balance = tokenAmount.mul(precisionIncrease).div(cumulativeInterest);

	if (!balance.eq(ZERO) && isVariant(balanceType, 'borrow')) {
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

	return tokenAmount.mul(price).div(precisionDecrease);
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

	return tokenAmount.mul(oraclePriceData.price).div(precisionDecrease);
}

export function calculateAssetWeight(
	balanceAmount: BN,
	oraclePrice: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory
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

export function calculateLiabilityWeight(
	size: BN,
	spotMarket: SpotMarketAccount,
	marginCategory: MarginCategory
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
 * calculates max borrow amount where rate would stay below targetBorrowRate
 * @param spotMarketAccount
 * @param targetBorrowRate
 * @returns : Precision: TOKEN DECIMALS
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

export function calculateInterestRate(
	bank: SpotMarketAccount,
	delta = ZERO,
	currentUtilization: BN = null
): BN {
	const utilization = currentUtilization || calculateUtilization(bank, delta);
	let interestRate: BN;
	if (utilization.gt(new BN(bank.optimalUtilization))) {
		const surplusUtilization = utilization.sub(new BN(bank.optimalUtilization));
		const borrowRateSlope = new BN(bank.maxBorrowRate - bank.optimalBorrowRate)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(
				SPOT_MARKET_UTILIZATION_PRECISION.sub(new BN(bank.optimalUtilization))
			);

		interestRate = new BN(bank.optimalBorrowRate).add(
			surplusUtilization
				.mul(borrowRateSlope)
				.div(SPOT_MARKET_UTILIZATION_PRECISION)
		);
	} else {
		const borrowRateSlope = new BN(bank.optimalBorrowRate)
			.mul(SPOT_MARKET_UTILIZATION_PRECISION)
			.div(new BN(bank.optimalUtilization));

		interestRate = utilization
			.mul(borrowRateSlope)
			.div(SPOT_MARKET_UTILIZATION_PRECISION);
	}

	return BN.max(
		interestRate,
		new BN(bank.minBorrowRate).mul(PERCENTAGE_PRECISION.divn(200))
	);
}

export function calculateDepositRate(
	bank: SpotMarketAccount,
	delta = ZERO,
	currentUtilization: BN = null
): BN {
	// positive delta => adding to deposit
	// negative delta => adding to borrow

	const utilization = currentUtilization || calculateUtilization(bank, delta);
	const borrowRate = calculateBorrowRate(bank, delta, utilization);
	const depositRate = borrowRate
		.mul(PERCENTAGE_PRECISION.sub(new BN(bank.insuranceFund.totalFactor)))
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION)
		.div(PERCENTAGE_PRECISION);
	return depositRate;
}

export function calculateBorrowRate(
	bank: SpotMarketAccount,
	delta = ZERO,
	currentUtilization: BN = null
): BN {
	return calculateInterestRate(bank, delta, currentUtilization);
}

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

export function calculateWithdrawLimit(
	spotMarket: SpotMarketAccount,
	now: BN
): {
	borrowLimit: BN;
	withdrawLimit: BN;
	minDepositAmount: BN;
	maxBorrowAmount: BN;
	currentDepositAmount;
	currentBorrowAmount;
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
	const maxBorrowTokensTwap = BN.max(
		spotMarket.withdrawGuardThreshold,
		BN.min(
			BN.max(
				marketDepositTokenAmount.div(new BN(6)),
				borrowTokenTwapLive.add(lesserDepositAmount.div(new BN(10)))
			),
			lesserDepositAmount.sub(lesserDepositAmount.div(new BN(5)))
		)
	); // between ~15-80% utilization with friction on twap

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

	if (withdrawLimit.eq(ZERO)) {
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
