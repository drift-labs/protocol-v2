import { BN } from '@coral-xyz/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	ONE,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	MARGIN_PRECISION,
	PRICE_DIV_PEG,
	PERCENTAGE_PRECISION,
	DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT,
	FUNDING_RATE_BUFFER_PRECISION,
	TWO,
} from '../constants/numericConstants';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	PerpMarketAccount,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import { squareRootBN, sigNum, clampBN, standardizeBaseAssetAmount } from '..';

import { OraclePriceData } from '../oracles/types';
import {
	calculateRepegCost,
	calculateAdjustKCost,
	calculateBudgetedPeg,
} from './repeg';

import { calculateLiveOracleStd, getNewOracleConfPct } from './oracles';

export function calculatePegFromTargetPrice(
	targetPrice: BN,
	baseAssetReserve: BN,
	quoteAssetReserve: BN
): BN {
	return BN.max(
		targetPrice
			.mul(baseAssetReserve)
			.div(quoteAssetReserve)
			.add(PRICE_DIV_PEG.div(new BN(2)))
			.div(PRICE_DIV_PEG),
		ONE
	);
}

export function calculateOptimalPegAndBudget(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN, BN, boolean] {
	const reservePriceBefore = calculatePrice(
		amm.baseAssetReserve,
		amm.quoteAssetReserve,
		amm.pegMultiplier
	);
	const targetPrice = oraclePriceData.price;
	const newPeg = calculatePegFromTargetPrice(
		targetPrice,
		amm.baseAssetReserve,
		amm.quoteAssetReserve
	);
	const prePegCost = calculateRepegCost(amm, newPeg);

	const totalFeeLB = amm.totalExchangeFee.div(new BN(2));
	const budget = BN.max(ZERO, amm.totalFeeMinusDistributions.sub(totalFeeLB));

	let checkLowerBound = true;
	if (budget.lt(prePegCost)) {
		const halfMaxPriceSpread = new BN(amm.maxSpread)
			.div(new BN(2))
			.mul(targetPrice)
			.div(BID_ASK_SPREAD_PRECISION);

		let newTargetPrice: BN;
		let newOptimalPeg: BN;
		let newBudget: BN;
		const targetPriceGap = reservePriceBefore.sub(targetPrice);

		if (targetPriceGap.abs().gt(halfMaxPriceSpread)) {
			const markAdj = targetPriceGap.abs().sub(halfMaxPriceSpread);

			if (targetPriceGap.lt(new BN(0))) {
				newTargetPrice = reservePriceBefore.add(markAdj);
			} else {
				newTargetPrice = reservePriceBefore.sub(markAdj);
			}

			newOptimalPeg = calculatePegFromTargetPrice(
				newTargetPrice,
				amm.baseAssetReserve,
				amm.quoteAssetReserve
			);

			newBudget = calculateRepegCost(amm, newOptimalPeg);
			checkLowerBound = false;

			return [newTargetPrice, newOptimalPeg, newBudget, false];
		} else if (
			amm.totalFeeMinusDistributions.lt(amm.totalExchangeFee.div(new BN(2)))
		) {
			checkLowerBound = false;
		}
	}

	return [targetPrice, newPeg, budget, checkLowerBound];
}

export function calculateNewAmm(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN, BN, BN] {
	let pKNumer = new BN(1);
	let pKDenom = new BN(1);

	const [targetPrice, _newPeg, budget, _checkLowerBound] =
		calculateOptimalPegAndBudget(amm, oraclePriceData);
	let prePegCost = calculateRepegCost(amm, _newPeg);
	let newPeg = _newPeg;

	if (prePegCost.gte(budget) && prePegCost.gt(ZERO)) {
		[pKNumer, pKDenom] = [new BN(999), new BN(1000)];
		const deficitMadeup = calculateAdjustKCost(amm, pKNumer, pKDenom);
		assert(deficitMadeup.lte(new BN(0)));
		prePegCost = budget.add(deficitMadeup.abs());
		const newAmm = Object.assign({}, amm);
		newAmm.baseAssetReserve = newAmm.baseAssetReserve.mul(pKNumer).div(pKDenom);
		newAmm.sqrtK = newAmm.sqrtK.mul(pKNumer).div(pKDenom);
		const invariant = newAmm.sqrtK.mul(newAmm.sqrtK);
		newAmm.quoteAssetReserve = invariant.div(newAmm.baseAssetReserve);
		const directionToClose = amm.baseAssetAmountWithAmm.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const [newQuoteAssetReserve, _newBaseAssetReserve] =
			calculateAmmReservesAfterSwap(
				newAmm,
				'base',
				amm.baseAssetAmountWithAmm.abs(),
				getSwapDirection('base', directionToClose)
			);

		newAmm.terminalQuoteAssetReserve = newQuoteAssetReserve;
		newPeg = calculateBudgetedPeg(newAmm, prePegCost, targetPrice);
		prePegCost = calculateRepegCost(newAmm, newPeg);
	}

	return [prePegCost, pKNumer, pKDenom, newPeg];
}

export function calculateUpdatedAMM(
	amm: AMM,
	oraclePriceData: OraclePriceData
): AMM {
	if (amm.curveUpdateIntensity == 0 || oraclePriceData === undefined) {
		return amm;
	}
	const newAmm = Object.assign({}, amm);
	const [prepegCost, pKNumer, pKDenom, newPeg] = calculateNewAmm(
		amm,
		oraclePriceData
	);

	newAmm.baseAssetReserve = newAmm.baseAssetReserve.mul(pKNumer).div(pKDenom);
	newAmm.sqrtK = newAmm.sqrtK.mul(pKNumer).div(pKDenom);
	const invariant = newAmm.sqrtK.mul(newAmm.sqrtK);
	newAmm.quoteAssetReserve = invariant.div(newAmm.baseAssetReserve);
	newAmm.pegMultiplier = newPeg;

	const directionToClose = amm.baseAssetAmountWithAmm.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, _newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			newAmm,
			'base',
			amm.baseAssetAmountWithAmm.abs(),
			getSwapDirection('base', directionToClose)
		);

	newAmm.terminalQuoteAssetReserve = newQuoteAssetReserve;

	newAmm.totalFeeMinusDistributions =
		newAmm.totalFeeMinusDistributions.sub(prepegCost);
	newAmm.netRevenueSinceLastFunding =
		newAmm.netRevenueSinceLastFunding.sub(prepegCost);
	return newAmm;
}

export function calculateUpdatedAMMSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData,
	isPrediction = false
): { baseAssetReserve: BN; quoteAssetReserve: BN; sqrtK: BN; newPeg: BN } {
	const newAmm = calculateUpdatedAMM(amm, oraclePriceData);
	const [shortReserves, longReserves] = calculateSpreadReserves(
		newAmm,
		oraclePriceData,
		undefined,
		isPrediction
	);

	const dirReserves = isVariant(direction, 'long')
		? longReserves
		: shortReserves;

	const result = {
		baseAssetReserve: dirReserves.baseAssetReserve,
		quoteAssetReserve: dirReserves.quoteAssetReserve,
		sqrtK: newAmm.sqrtK,
		newPeg: newAmm.pegMultiplier,
	};

	return result;
}

export function calculateBidAskPrice(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	withUpdate = true,
	isPrediction = false
): [BN, BN] {
	let newAmm: AMM;
	if (withUpdate) {
		newAmm = calculateUpdatedAMM(amm, oraclePriceData);
	} else {
		newAmm = amm;
	}

	const [bidReserves, askReserves] = calculateSpreadReserves(
		newAmm,
		oraclePriceData,
		undefined,
		isPrediction
	);

	const askPrice = calculatePrice(
		askReserves.baseAssetReserve,
		askReserves.quoteAssetReserve,
		newAmm.pegMultiplier
	);

	const bidPrice = calculatePrice(
		bidReserves.baseAssetReserve,
		bidReserves.quoteAssetReserve,
		newAmm.pegMultiplier
	);

	return [bidPrice, askPrice];
}

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetReserves
 * @param quoteAssetReserves
 * @param pegMultiplier
 * @returns price : Precision PRICE_PRECISION
 */
export function calculatePrice(
	baseAssetReserves: BN,
	quoteAssetReserves: BN,
	pegMultiplier: BN
): BN {
	if (baseAssetReserves.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetReserves
		.mul(PRICE_PRECISION)
		.mul(pegMultiplier)
		.div(PEG_PRECISION)
		.div(baseAssetReserves);
}

export type AssetType = 'quote' | 'base';

/**
 * Calculates what the amm reserves would be after swapping a quote or base asset amount.
 *
 * @param amm
 * @param inputAssetType
 * @param swapAmount
 * @param swapDirection
 * @returns quoteAssetReserve and baseAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateAmmReservesAfterSwap(
	amm: Pick<
		AMM,
		'pegMultiplier' | 'quoteAssetReserve' | 'sqrtK' | 'baseAssetReserve'
	>,
	inputAssetType: AssetType,
	swapAmount: BN,
	swapDirection: SwapDirection
): [BN, BN] {
	assert(swapAmount.gte(ZERO), 'swapAmount must be greater than 0');

	let newQuoteAssetReserve;
	let newBaseAssetReserve;

	if (inputAssetType === 'quote') {
		swapAmount = swapAmount
			.mul(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
			.div(amm.pegMultiplier);

		[newQuoteAssetReserve, newBaseAssetReserve] = calculateSwapOutput(
			amm.quoteAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	} else {
		[newBaseAssetReserve, newQuoteAssetReserve] = calculateSwapOutput(
			amm.baseAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	}

	return [newQuoteAssetReserve, newBaseAssetReserve];
}

export function calculateMarketOpenBidAsk(
	baseAssetReserve: BN,
	minBaseAssetReserve: BN,
	maxBaseAssetReserve: BN,
	stepSize?: BN
): [BN, BN] {
	// open orders
	let openAsks;
	if (minBaseAssetReserve.lt(baseAssetReserve)) {
		openAsks = baseAssetReserve.sub(minBaseAssetReserve).mul(new BN(-1));

		if (stepSize && openAsks.abs().div(TWO).lt(stepSize)) {
			openAsks = ZERO;
		}
	} else {
		openAsks = ZERO;
	}

	let openBids;
	if (maxBaseAssetReserve.gt(baseAssetReserve)) {
		openBids = maxBaseAssetReserve.sub(baseAssetReserve);

		if (stepSize && openBids.div(TWO).lt(stepSize)) {
			openBids = ZERO;
		}
	} else {
		openBids = ZERO;
	}

	return [openBids, openAsks];
}

export function calculateInventoryLiquidityRatio(
	baseAssetAmountWithAmm: BN,
	baseAssetReserve: BN,
	minBaseAssetReserve: BN,
	maxBaseAssetReserve: BN
): BN {
	// inventory skew
	const [openBids, openAsks] = calculateMarketOpenBidAsk(
		baseAssetReserve,
		minBaseAssetReserve,
		maxBaseAssetReserve
	);

	const minSideLiquidity = BN.min(openBids.abs(), openAsks.abs());

	const inventoryScaleBN = BN.min(
		baseAssetAmountWithAmm
			.mul(PERCENTAGE_PRECISION)
			.div(BN.max(minSideLiquidity, ONE))
			.abs(),
		PERCENTAGE_PRECISION
	);
	return inventoryScaleBN;
}

export function calculateInventoryScale(
	baseAssetAmountWithAmm: BN,
	baseAssetReserve: BN,
	minBaseAssetReserve: BN,
	maxBaseAssetReserve: BN,
	directionalSpread: number,
	maxSpread: number
): number {
	if (baseAssetAmountWithAmm.eq(ZERO)) {
		return 1;
	}

	const MAX_BID_ASK_INVENTORY_SKEW_FACTOR = BID_ASK_SPREAD_PRECISION.mul(
		new BN(10)
	);

	const inventoryScaleBN = calculateInventoryLiquidityRatio(
		baseAssetAmountWithAmm,
		baseAssetReserve,
		minBaseAssetReserve,
		maxBaseAssetReserve
	);

	const inventoryScaleMaxBN = BN.max(
		MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
		new BN(maxSpread)
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(new BN(Math.max(directionalSpread, 1)))
	);

	const inventoryScaleCapped =
		BN.min(
			inventoryScaleMaxBN,
			BID_ASK_SPREAD_PRECISION.add(
				inventoryScaleMaxBN.mul(inventoryScaleBN).div(PERCENTAGE_PRECISION)
			)
		).toNumber() / BID_ASK_SPREAD_PRECISION.toNumber();

	return inventoryScaleCapped;
}

export function calculateReferencePriceOffset(
	reservePrice: BN,
	last24hAvgFundingRate: BN,
	liquidityFraction: BN,
	oracleTwapFast: BN,
	markTwapFast: BN,
	oracleTwapSlow: BN,
	markTwapSlow: BN,
	maxOffsetPct: number
): BN {
	if (last24hAvgFundingRate.eq(ZERO)) {
		return ZERO;
	}

	const maxOffsetInPrice = new BN(maxOffsetPct)
		.mul(reservePrice)
		.div(PERCENTAGE_PRECISION);

	// Calculate quote denominated market premium
	const markPremiumMinute = clampBN(
		markTwapFast.sub(oracleTwapFast),
		maxOffsetInPrice.mul(new BN(-1)),
		maxOffsetInPrice
	);

	const markPremiumHour = clampBN(
		markTwapSlow.sub(oracleTwapSlow),
		maxOffsetInPrice.mul(new BN(-1)),
		maxOffsetInPrice
	);

	// Convert last24hAvgFundingRate to quote denominated premium
	const markPremiumDay = clampBN(
		last24hAvgFundingRate.div(FUNDING_RATE_BUFFER_PRECISION).mul(new BN(24)),
		maxOffsetInPrice.mul(new BN(-1)),
		maxOffsetInPrice
	);

	// Take average clamped premium as the price-based offset
	const markPremiumAvg = markPremiumMinute
		.add(markPremiumHour)
		.add(markPremiumDay)
		.div(new BN(3));

	const markPremiumAvgPct = markPremiumAvg
		.mul(PRICE_PRECISION)
		.div(reservePrice);

	const inventoryPct = clampBN(
		liquidityFraction.mul(new BN(maxOffsetPct)).div(PERCENTAGE_PRECISION),
		maxOffsetInPrice.mul(new BN(-1)),
		maxOffsetInPrice
	);

	// Only apply when inventory is consistent with recent and 24h market premium
	let offsetPct = markPremiumAvgPct.add(inventoryPct);

	if (!sigNum(inventoryPct).eq(sigNum(markPremiumAvgPct))) {
		offsetPct = ZERO;
	}

	const clampedOffsetPct = clampBN(
		offsetPct,
		new BN(-maxOffsetPct),
		new BN(maxOffsetPct)
	);

	return clampedOffsetPct;
}

export function calculateEffectiveLeverage(
	baseSpread: number,
	quoteAssetReserve: BN,
	terminalQuoteAssetReserve: BN,
	pegMultiplier: BN,
	netBaseAssetAmount: BN,
	reservePrice: BN,
	totalFeeMinusDistributions: BN
): number {
	// vAMM skew
	const netBaseAssetValue = quoteAssetReserve
		.sub(terminalQuoteAssetReserve)
		.mul(pegMultiplier)
		.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

	const localBaseAssetValue = netBaseAssetAmount
		.mul(reservePrice)
		.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(PRICE_PRECISION));

	const effectiveGap = Math.max(
		0,
		localBaseAssetValue.sub(netBaseAssetValue).toNumber()
	);

	const effectiveLeverage =
		effectiveGap / (Math.max(0, totalFeeMinusDistributions.toNumber()) + 1) +
		1 / QUOTE_PRECISION.toNumber();

	return effectiveLeverage;
}

export function calculateMaxSpread(marginRatioInitial: number): number {
	const maxTargetSpread: number = new BN(marginRatioInitial)
		.mul(BID_ASK_SPREAD_PRECISION.div(MARGIN_PRECISION))
		.toNumber();

	return maxTargetSpread;
}

export function calculateVolSpreadBN(
	lastOracleConfPct: BN,
	reservePrice: BN,
	markStd: BN,
	oracleStd: BN,
	longIntensity: BN,
	shortIntensity: BN,
	volume24H: BN
): [BN, BN] {
	const marketAvgStdPct = markStd
		.add(oracleStd)
		.mul(PERCENTAGE_PRECISION)
		.div(reservePrice)
		.div(new BN(2));
	const volSpread = BN.max(lastOracleConfPct, marketAvgStdPct.div(new BN(2)));

	const clampMin = PERCENTAGE_PRECISION.div(new BN(100));
	const clampMax = PERCENTAGE_PRECISION.mul(new BN(16)).div(new BN(10));

	const longVolSpreadFactor = clampBN(
		longIntensity.mul(PERCENTAGE_PRECISION).div(BN.max(ONE, volume24H)),
		clampMin,
		clampMax
	);
	const shortVolSpreadFactor = clampBN(
		shortIntensity.mul(PERCENTAGE_PRECISION).div(BN.max(ONE, volume24H)),
		clampMin,
		clampMax
	);

	// only consider confidence interval at full value when above 25 bps
	let confComponent = lastOracleConfPct;

	if (lastOracleConfPct.lte(PRICE_PRECISION.div(new BN(400)))) {
		confComponent = lastOracleConfPct.div(new BN(10));
	}

	const longVolSpread = BN.max(
		confComponent,
		volSpread.mul(longVolSpreadFactor).div(PERCENTAGE_PRECISION)
	);
	const shortVolSpread = BN.max(
		confComponent,
		volSpread.mul(shortVolSpreadFactor).div(PERCENTAGE_PRECISION)
	);

	return [longVolSpread, shortVolSpread];
}

export function calculateSpreadBN(
	baseSpread: number,
	lastOracleReservePriceSpreadPct: BN,
	lastOracleConfPct: BN,
	maxSpread: number,
	quoteAssetReserve: BN,
	terminalQuoteAssetReserve: BN,
	pegMultiplier: BN,
	baseAssetAmountWithAmm: BN,
	reservePrice: BN,
	totalFeeMinusDistributions: BN,
	netRevenueSinceLastFunding: BN,
	baseAssetReserve: BN,
	minBaseAssetReserve: BN,
	maxBaseAssetReserve: BN,
	markStd: BN,
	oracleStd: BN,
	longIntensity: BN,
	shortIntensity: BN,
	volume24H: BN,
	returnTerms = false
) {
	assert(Number.isInteger(baseSpread));
	assert(Number.isInteger(maxSpread));

	const spreadTerms = {
		longVolSpread: 0,
		shortVolSpread: 0,
		longSpreadwPS: 0,
		shortSpreadwPS: 0,
		maxTargetSpread: 0,
		inventorySpreadScale: 0,
		longSpreadwInvScale: 0,
		shortSpreadwInvScale: 0,
		effectiveLeverage: 0,
		effectiveLeverageCapped: 0,
		longSpreadwEL: 0,
		shortSpreadwEL: 0,
		revenueRetreatAmount: 0,
		halfRevenueRetreatAmount: 0,
		longSpreadwRevRetreat: 0,
		shortSpreadwRevRetreat: 0,
		longSpreadwOffsetShrink: 0,
		shortSpreadwOffsetShrink: 0,
		totalSpread: 0,
		longSpread: 0,
		shortSpread: 0,
	};

	const [longVolSpread, shortVolSpread] = calculateVolSpreadBN(
		lastOracleConfPct,
		reservePrice,
		markStd,
		oracleStd,
		longIntensity,
		shortIntensity,
		volume24H
	);

	spreadTerms.longVolSpread = longVolSpread.toNumber();
	spreadTerms.shortVolSpread = shortVolSpread.toNumber();

	let longSpread = Math.max(baseSpread / 2, longVolSpread.toNumber());
	let shortSpread = Math.max(baseSpread / 2, shortVolSpread.toNumber());

	if (lastOracleReservePriceSpreadPct.gt(ZERO)) {
		shortSpread = Math.max(
			shortSpread,
			lastOracleReservePriceSpreadPct.abs().toNumber() +
				shortVolSpread.toNumber()
		);
	} else if (lastOracleReservePriceSpreadPct.lt(ZERO)) {
		longSpread = Math.max(
			longSpread,
			lastOracleReservePriceSpreadPct.abs().toNumber() +
				longVolSpread.toNumber()
		);
	}
	spreadTerms.longSpreadwPS = longSpread;
	spreadTerms.shortSpreadwPS = shortSpread;

	const maxSpreadBaseline = Math.min(
		Math.max(
			lastOracleReservePriceSpreadPct.abs().toNumber(),
			lastOracleConfPct.muln(2).toNumber(),
			BN.max(markStd, oracleStd)
				.mul(PERCENTAGE_PRECISION)
				.div(reservePrice)
				.toNumber()
		),
		BID_ASK_SPREAD_PRECISION.toNumber()
	);

	const maxTargetSpread: number = Math.floor(
		Math.max(maxSpread, maxSpreadBaseline)
	);

	const inventorySpreadScale = calculateInventoryScale(
		baseAssetAmountWithAmm,
		baseAssetReserve,
		minBaseAssetReserve,
		maxBaseAssetReserve,
		baseAssetAmountWithAmm.gt(ZERO) ? longSpread : shortSpread,
		maxTargetSpread
	);

	if (baseAssetAmountWithAmm.gt(ZERO)) {
		longSpread *= inventorySpreadScale;
	} else if (baseAssetAmountWithAmm.lt(ZERO)) {
		shortSpread *= inventorySpreadScale;
	}
	spreadTerms.maxTargetSpread = maxTargetSpread;
	spreadTerms.inventorySpreadScale = inventorySpreadScale;
	spreadTerms.longSpreadwInvScale = longSpread;
	spreadTerms.shortSpreadwInvScale = shortSpread;

	const MAX_SPREAD_SCALE = 10;
	if (totalFeeMinusDistributions.gt(ZERO)) {
		const effectiveLeverage = calculateEffectiveLeverage(
			baseSpread,
			quoteAssetReserve,
			terminalQuoteAssetReserve,
			pegMultiplier,
			baseAssetAmountWithAmm,
			reservePrice,
			totalFeeMinusDistributions
		);
		spreadTerms.effectiveLeverage = effectiveLeverage;

		const spreadScale = Math.min(MAX_SPREAD_SCALE, 1 + effectiveLeverage);
		spreadTerms.effectiveLeverageCapped = spreadScale;

		if (baseAssetAmountWithAmm.gt(ZERO)) {
			longSpread *= spreadScale;
			longSpread = Math.floor(longSpread);
		} else {
			shortSpread *= spreadScale;
			shortSpread = Math.floor(shortSpread);
		}
	} else {
		longSpread *= MAX_SPREAD_SCALE;
		shortSpread *= MAX_SPREAD_SCALE;
	}

	spreadTerms.longSpreadwEL = longSpread;
	spreadTerms.shortSpreadwEL = shortSpread;

	if (
		netRevenueSinceLastFunding.lt(
			DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT
		)
	) {
		const maxRetreat = maxTargetSpread / 10;
		let revenueRetreatAmount = maxRetreat;
		if (
			netRevenueSinceLastFunding.gte(
				DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.mul(new BN(1000))
			)
		) {
			revenueRetreatAmount = Math.min(
				maxRetreat,
				Math.floor(
					(baseSpread * netRevenueSinceLastFunding.abs().toNumber()) /
						DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.abs().toNumber()
				)
			);
		}

		const halfRevenueRetreatAmount = Math.floor(revenueRetreatAmount / 2);

		spreadTerms.revenueRetreatAmount = revenueRetreatAmount;
		spreadTerms.halfRevenueRetreatAmount = halfRevenueRetreatAmount;

		if (baseAssetAmountWithAmm.gt(ZERO)) {
			longSpread += revenueRetreatAmount;
			shortSpread += halfRevenueRetreatAmount;
		} else if (baseAssetAmountWithAmm.lt(ZERO)) {
			longSpread += halfRevenueRetreatAmount;
			shortSpread += revenueRetreatAmount;
		} else {
			longSpread += halfRevenueRetreatAmount;
			shortSpread += halfRevenueRetreatAmount;
		}
	}

	spreadTerms.longSpreadwRevRetreat = longSpread;
	spreadTerms.shortSpreadwRevRetreat = shortSpread;

	const totalSpread = longSpread + shortSpread;
	if (totalSpread > maxTargetSpread) {
		if (longSpread > shortSpread) {
			longSpread = Math.ceil((longSpread * maxTargetSpread) / totalSpread);
			shortSpread = Math.floor(maxTargetSpread - longSpread);
		} else {
			shortSpread = Math.ceil((shortSpread * maxTargetSpread) / totalSpread);
			longSpread = Math.floor(maxTargetSpread - shortSpread);
		}
	}

	spreadTerms.totalSpread = totalSpread;
	spreadTerms.longSpread = longSpread;
	spreadTerms.shortSpread = shortSpread;
	if (returnTerms) {
		return spreadTerms;
	}
	return [longSpread, shortSpread];
}

export function calculateSpread(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	now?: BN,
	reservePrice?: BN
): [number, number] {
	if (amm.baseSpread == 0 || amm.curveUpdateIntensity == 0) {
		return [amm.baseSpread / 2, amm.baseSpread / 2];
	}

	if (!reservePrice) {
		reservePrice = calculatePrice(
			amm.baseAssetReserve,
			amm.quoteAssetReserve,
			amm.pegMultiplier
		);
	}

	const targetPrice = oraclePriceData?.price || reservePrice;
	const targetMarkSpreadPct = reservePrice
		.sub(targetPrice)
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(reservePrice);

	now = now || new BN(new Date().getTime() / 1000); //todo
	const liveOracleStd = calculateLiveOracleStd(amm, oraclePriceData, now);
	const confIntervalPct = getNewOracleConfPct(
		amm,
		oraclePriceData,
		reservePrice,
		now
	);

	const spreads = calculateSpreadBN(
		amm.baseSpread,
		targetMarkSpreadPct,
		confIntervalPct,
		amm.maxSpread,
		amm.quoteAssetReserve,
		amm.terminalQuoteAssetReserve,
		amm.pegMultiplier,
		amm.baseAssetAmountWithAmm,
		reservePrice,
		amm.totalFeeMinusDistributions,
		amm.netRevenueSinceLastFunding,
		amm.baseAssetReserve,
		amm.minBaseAssetReserve,
		amm.maxBaseAssetReserve,
		amm.markStd,
		liveOracleStd,
		amm.longIntensityVolume,
		amm.shortIntensityVolume,
		amm.volume24H
	);
	const longSpread = spreads[0];
	const shortSpread = spreads[1];

	return [longSpread, shortSpread];
}

export function getQuoteAssetReservePredictionMarketBounds(
	amm: AMM,
	direction: PositionDirection
): [BN, BN] {
	let quoteAssetReserveLowerBound = ZERO;

	const pegSqrt = squareRootBN(
		amm.pegMultiplier.mul(PEG_PRECISION).addn(1)
	).addn(1);

	let quoteAssetReserveUpperBound = amm.sqrtK
		.mul(pegSqrt)
		.div(amm.pegMultiplier);

	if (direction === PositionDirection.LONG) {
		quoteAssetReserveLowerBound = amm.sqrtK
			.muln(22361)
			.mul(pegSqrt)
			.divn(100000)
			.div(amm.pegMultiplier);
	} else {
		quoteAssetReserveUpperBound = amm.sqrtK
			.muln(97467)
			.mul(pegSqrt)
			.divn(100000)
			.div(amm.pegMultiplier);
	}

	return [quoteAssetReserveLowerBound, quoteAssetReserveUpperBound];
}

export function calculateSpreadReserves(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	now?: BN,
	isPrediction = false
) {
	function calculateSpreadReserve(
		spread: number,
		direction: PositionDirection,
		amm: AMM
	): {
		baseAssetReserve;
		quoteAssetReserve;
	} {
		if (spread === 0) {
			return {
				baseAssetReserve: amm.baseAssetReserve,
				quoteAssetReserve: amm.quoteAssetReserve,
			};
		}
		let spreadFraction = new BN(spread / 2);

		// make non-zero
		if (spreadFraction.eq(ZERO)) {
			spreadFraction = spread >= 0 ? new BN(1) : new BN(-1);
		}

		const quoteAssetReserveDelta = amm.quoteAssetReserve.div(
			BID_ASK_SPREAD_PRECISION.div(spreadFraction)
		);

		let quoteAssetReserve;
		if (quoteAssetReserveDelta.gte(ZERO)) {
			quoteAssetReserve = amm.quoteAssetReserve.add(
				quoteAssetReserveDelta.abs()
			);
		} else {
			quoteAssetReserve = amm.quoteAssetReserve.sub(
				quoteAssetReserveDelta.abs()
			);
		}

		if (isPrediction) {
			const [qarLower, qarUpper] = getQuoteAssetReservePredictionMarketBounds(
				amm,
				direction
			);
			quoteAssetReserve = clampBN(quoteAssetReserve, qarLower, qarUpper);
		}

		const baseAssetReserve = amm.sqrtK.mul(amm.sqrtK).div(quoteAssetReserve);
		return {
			baseAssetReserve,
			quoteAssetReserve,
		};
	}

	const reservePrice = calculatePrice(
		amm.baseAssetReserve,
		amm.quoteAssetReserve,
		amm.pegMultiplier
	);

	// always allow 10 bps of price offset, up to a fifth of the market's max_spread
	let maxOffset = 0;
	let referencePriceOffset = ZERO;
	if (amm.curveUpdateIntensity > 100) {
		maxOffset = Math.max(
			amm.maxSpread / 5,
			(PERCENTAGE_PRECISION.toNumber() / 10000) *
				(amm.curveUpdateIntensity - 100)
		);

		const liquidityFraction = calculateInventoryLiquidityRatio(
			amm.baseAssetAmountWithAmm,
			amm.baseAssetReserve,
			amm.minBaseAssetReserve,
			amm.maxBaseAssetReserve
		);
		const liquidityFractionSigned = liquidityFraction.mul(
			sigNum(amm.baseAssetAmountWithAmm.add(amm.baseAssetAmountWithUnsettledLp))
		);
		referencePriceOffset = calculateReferencePriceOffset(
			reservePrice,
			amm.last24HAvgFundingRate,
			liquidityFractionSigned,
			amm.historicalOracleData.lastOraclePriceTwap5Min,
			amm.lastMarkPriceTwap5Min,
			amm.historicalOracleData.lastOraclePriceTwap,
			amm.lastMarkPriceTwap,
			maxOffset
		);
	}

	const [longSpread, shortSpread] = calculateSpread(
		amm,
		oraclePriceData,
		now,
		reservePrice
	);

	const askReserves = calculateSpreadReserve(
		longSpread + referencePriceOffset.toNumber(),
		PositionDirection.LONG,
		amm
	);
	const bidReserves = calculateSpreadReserve(
		-shortSpread + referencePriceOffset.toNumber(),
		PositionDirection.SHORT,
		amm
	);

	return [bidReserves, askReserves];
}

/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutput(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	const newOutputAssetReserve = invariant.div(newInputAssetReserve);
	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Translate long/shorting quote/base asset into amm operation
 *
 * @param inputAssetType
 * @param positionDirection
 */
export function getSwapDirection(
	inputAssetType: AssetType,
	positionDirection: PositionDirection
): SwapDirection {
	if (isVariant(positionDirection, 'long') && inputAssetType === 'base') {
		return SwapDirection.REMOVE;
	}

	if (isVariant(positionDirection, 'short') && inputAssetType === 'quote') {
		return SwapDirection.REMOVE;
	}

	return SwapDirection.ADD;
}

/**
 * Helper function calculating terminal price of amm
 *
 * @param market
 * @returns cost : Precision PRICE_PRECISION
 */
export function calculateTerminalPrice(market: PerpMarketAccount) {
	const directionToClose = market.amm.baseAssetAmountWithAmm.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.amm.baseAssetAmountWithAmm.abs(),
			getSwapDirection('base', directionToClose)
		);

	const terminalPrice = newQuoteAssetReserve
		.mul(PRICE_PRECISION)
		.mul(market.amm.pegMultiplier)
		.div(PEG_PRECISION)
		.div(newBaseAssetReserve);

	return terminalPrice;
}

export function calculateMaxBaseAssetAmountToTrade(
	amm: AMM,
	limit_price: BN,
	direction: PositionDirection,
	oraclePriceData?: OraclePriceData,
	now?: BN,
	isPrediction = false
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(newBaseAssetReserveSquared);
	const [shortSpreadReserves, longSpreadReserves] = calculateSpreadReserves(
		amm,
		oraclePriceData,
		now,
		isPrediction
	);

	const baseAssetReserveBefore: BN = isVariant(direction, 'long')
		? longSpreadReserves.baseAssetReserve
		: shortSpreadReserves.baseAssetReserve;

	if (newBaseAssetReserve.gt(baseAssetReserveBefore)) {
		return [
			newBaseAssetReserve.sub(baseAssetReserveBefore),
			PositionDirection.SHORT,
		];
	} else if (newBaseAssetReserve.lt(baseAssetReserveBefore)) {
		return [
			baseAssetReserveBefore.sub(newBaseAssetReserve),
			PositionDirection.LONG,
		];
	} else {
		console.log('tradeSize Too Small');
		return [new BN(0), PositionDirection.LONG];
	}
}

export function calculateQuoteAssetAmountSwapped(
	quoteAssetReserves: BN,
	pegMultiplier: BN,
	swapDirection: SwapDirection
): BN {
	if (isVariant(swapDirection, 'remove')) {
		quoteAssetReserves = quoteAssetReserves.add(ONE);
	}

	let quoteAssetAmount = quoteAssetReserves
		.mul(pegMultiplier)
		.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

	if (isVariant(swapDirection, 'remove')) {
		quoteAssetAmount = quoteAssetAmount.add(ONE);
	}

	return quoteAssetAmount;
}

export function calculateMaxBaseAssetAmountFillable(
	amm: AMM,
	orderDirection: PositionDirection
): BN {
	const maxFillSize = amm.baseAssetReserve.div(
		new BN(amm.maxFillReserveFraction)
	);
	let maxBaseAssetAmountOnSide: BN;
	if (isVariant(orderDirection, 'long')) {
		maxBaseAssetAmountOnSide = BN.max(
			ZERO,
			amm.baseAssetReserve.sub(amm.minBaseAssetReserve)
		);
	} else {
		maxBaseAssetAmountOnSide = BN.max(
			ZERO,
			amm.maxBaseAssetReserve.sub(amm.baseAssetReserve)
		);
	}

	return standardizeBaseAssetAmount(
		BN.min(maxFillSize, maxBaseAssetAmountOnSide),
		amm.orderStepSize
	);
}
