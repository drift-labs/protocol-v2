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
 * @param {OraclePriceData} oraclePriceData - The oracle price data (typically a token/USD oracle).
 * @param {BN} oraclePriceTwap - The Time-Weighted Average Price of the oracle.
 * @return {BN} The calculated value of the given token amount, scaled by `PRICE_PRECISION`
 */
export function getStrictTokenValue(
	tokenAmount: BN,
	spotDecimals: number,
	oraclePriceData: OraclePriceData,
	oraclePriceTwap: BN
): BN {
	if (tokenAmount.eq(ZERO)) {
		return ZERO;
	}

	let price = oraclePriceData.price;
	if (tokenAmount.gt(ZERO)) {
		price = BN.min(oraclePriceData.price, oraclePriceTwap);
	} else {
		price = BN.max(oraclePriceData.price, oraclePriceTwap);
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
	oraclePriceData: OraclePriceData
): BN {
	if (tokenAmount.eq(ZERO)) {
		return ZERO;
	}

	const precisionDecrease = TEN.pow(new BN(spotDecimals));

	return tokenAmount.mul(oraclePriceData.price).div(precisionDecrease);
}

export function calculateAssetWeight(
	balanceAmount: BN,
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
				new BN(spotMarket.initialAssetWeight)
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
			assetWeight = new BN(spotMarket.initialAssetWeight);
			break;
	}

	return assetWeight;
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
			liabilityWeight = spotMarket.initialLiabilityWeight;
			break;
	}

	return liabilityWeight;
}

export function calculateUtilization(bank: SpotMarketAccount): BN {
	const tokenDepositAmount = getTokenAmount(
		bank.depositBalance,
		bank,
		SpotBalanceType.DEPOSIT
	);
	const tokenBorrowAmount = getTokenAmount(
		bank.borrowBalance,
		bank,
		SpotBalanceType.BORROW
	);

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

export function calculateInterestRate(bank: SpotMarketAccount): BN {
	const utilization = calculateUtilization(bank);

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
			.div(
				SPOT_MARKET_UTILIZATION_PRECISION.sub(new BN(bank.optimalUtilization))
			);

		interestRate = utilization
			.mul(borrowRateSlope)
			.div(SPOT_MARKET_UTILIZATION_PRECISION);
	}

	return interestRate;
}

export function calculateDepositRate(bank: SpotMarketAccount): BN {
	const utilization = calculateUtilization(bank);
	const borrowRate = calculateBorrowRate(bank);
	const depositRate = borrowRate
		.mul(PERCENTAGE_PRECISION.sub(new BN(bank.insuranceFund.totalFactor)))
		.mul(utilization)
		.div(SPOT_MARKET_UTILIZATION_PRECISION)
		.div(PERCENTAGE_PRECISION);
	return depositRate;
}

export function calculateBorrowRate(bank: SpotMarketAccount): BN {
	return calculateInterestRate(bank);
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

	const maxBorrowTokens = BN.max(
		spotMarket.withdrawGuardThreshold,
		BN.min(
			BN.max(
				marketDepositTokenAmount.div(new BN(6)),
				borrowTokenTwapLive.add(marketDepositTokenAmount.div(new BN(10)))
			),
			marketDepositTokenAmount.sub(marketDepositTokenAmount.div(new BN(5)))
		)
	); // between ~15-80% utilization with friction on twap

	const minDepositTokens = depositTokenTwapLive.sub(
		BN.max(
			depositTokenTwapLive.div(new BN(4)),
			BN.min(spotMarket.withdrawGuardThreshold, depositTokenTwapLive)
		)
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
