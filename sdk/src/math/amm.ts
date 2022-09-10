import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	ONE,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	MARGIN_PRECISION,
	PRICE_DIV_PEG,
} from '../constants/numericConstants';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	PerpMarketAccount,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import { squareRootBN, standardizeBaseAssetAmount } from '..';

import { OraclePriceData } from '../oracles/types';
import {
	calculateRepegCost,
	calculateAdjustKCost,
	calculateBudgetedPeg,
} from './repeg';

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
	const markPriceBefore = calculatePrice(
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
	if (budget.lt(prePegCost)) {
		const maxPriceSpread = new BN(amm.maxSpread)
			.mul(targetPrice)
			.div(BID_ASK_SPREAD_PRECISION);

		let newTargetPrice: BN;
		let newOptimalPeg: BN;
		let newBudget: BN;
		const targetPriceGap = markPriceBefore.sub(targetPrice);

		if (targetPriceGap.abs().gt(maxPriceSpread)) {
			const markAdj = targetPriceGap.abs().sub(maxPriceSpread);

			if (targetPriceGap.lt(new BN(0))) {
				newTargetPrice = markPriceBefore.add(markAdj);
			} else {
				newTargetPrice = markPriceBefore.sub(markAdj);
			}

			newOptimalPeg = calculatePegFromTargetPrice(
				newTargetPrice,
				amm.baseAssetReserve,
				amm.quoteAssetReserve
			);

			newBudget = calculateRepegCost(amm, newOptimalPeg);
			return [newTargetPrice, newOptimalPeg, newBudget, false];
		}
	}

	return [targetPrice, newPeg, budget, true];
}

export function calculateNewAmm(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN, BN, BN] {
	let pKNumer = new BN(1);
	let pKDenom = new BN(1);

	const [targetPrice, _newPeg, budget, checkLowerBound] =
		calculateOptimalPegAndBudget(amm, oraclePriceData);
	let prePegCost = calculateRepegCost(amm, _newPeg);
	let newPeg = _newPeg;

	if (prePegCost.gt(budget) && checkLowerBound) {
		[pKNumer, pKDenom] = [new BN(999), new BN(1000)];
		const deficitMadeup = calculateAdjustKCost(amm, pKNumer, pKDenom);
		assert(deficitMadeup.lte(new BN(0)));
		prePegCost = budget.add(deficitMadeup.abs());
		const newAmm = Object.assign({}, amm);
		newAmm.baseAssetReserve = newAmm.baseAssetReserve.mul(pKNumer).div(pKDenom);
		newAmm.sqrtK = newAmm.sqrtK.mul(pKNumer).div(pKDenom);
		const invariant = newAmm.sqrtK.mul(newAmm.sqrtK);
		newAmm.quoteAssetReserve = invariant.div(newAmm.baseAssetReserve);
		const directionToClose = amm.netBaseAssetAmount.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const [newQuoteAssetReserve, _newBaseAssetReserve] =
			calculateAmmReservesAfterSwap(
				newAmm,
				'base',
				amm.netBaseAssetAmount.abs(),
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
	if (amm.curveUpdateIntensity == 0) {
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

	const directionToClose = amm.netBaseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, _newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			newAmm,
			'base',
			amm.netBaseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);

	newAmm.terminalQuoteAssetReserve = newQuoteAssetReserve;

	newAmm.totalFeeMinusDistributions =
		newAmm.totalFeeMinusDistributions.sub(prepegCost);

	return newAmm;
}

export function calculateUpdatedAMMSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): { baseAssetReserve: BN; quoteAssetReserve: BN; sqrtK: BN; newPeg: BN } {
	const newAmm = calculateUpdatedAMM(amm, oraclePriceData);
	const dirReserves = calculateSpreadReserves(
		newAmm,
		direction,
		oraclePriceData
	);
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
	withUpdate = true
): [BN, BN] {
	let newAmm: AMM;
	if (withUpdate) {
		newAmm = calculateUpdatedAMM(amm, oraclePriceData);
	} else {
		newAmm = amm;
	}

	const askReserves = calculateSpreadReserves(
		newAmm,
		PositionDirection.LONG,
		oraclePriceData
	);
	const bidReserves = calculateSpreadReserves(
		newAmm,
		PositionDirection.SHORT,
		oraclePriceData
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
 * @returns price : Precision MARK_PRICE_PRECISION
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
		.mul(MARK_PRICE_PRECISION)
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
	maxBaseAssetReserve: BN
): [BN, BN] {
	// open orders
	let openAsks;
	if (maxBaseAssetReserve > baseAssetReserve) {
		openAsks = maxBaseAssetReserve.sub(baseAssetReserve).mul(new BN(-1));
	} else {
		openAsks = ZERO;
	}

	let openBids;
	if (minBaseAssetReserve < baseAssetReserve) {
		openBids = baseAssetReserve.sub(minBaseAssetReserve);
	} else {
		openBids = ZERO;
	}
	return [openBids, openAsks];
}

export function calculateInventoryScale(
	netBaseAssetAmount: BN,
	baseAssetReserve: BN,
	minBaseAssetReserve: BN,
	maxBaseAssetReserve: BN
): number {
	// inventory skew
	const [openBids, openAsks] = calculateMarketOpenBidAsk(
		baseAssetReserve,
		minBaseAssetReserve,
		maxBaseAssetReserve
	);

	const totalLiquidity = BN.max(openBids.abs().add(openAsks.abs()), new BN(1));
	const inventoryScale =
		BN.min(netBaseAssetAmount.abs(), totalLiquidity)
			.mul(BID_ASK_SPREAD_PRECISION.mul(new BN(5)))
			.div(totalLiquidity)
			.toNumber() / BID_ASK_SPREAD_PRECISION.toNumber();

	return inventoryScale;
}

export function calculateEffectiveLeverage(
	baseSpread: number,
	quoteAssetReserve: BN,
	terminalQuoteAssetReserve: BN,
	pegMultiplier: BN,
	netBaseAssetAmount: BN,
	markPrice: BN,
	totalFeeMinusDistributions: BN
): number {
	// inventory skew
	const netBaseAssetValue = quoteAssetReserve
		.sub(terminalQuoteAssetReserve)
		.mul(pegMultiplier)
		.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

	const localBaseAssetValue = netBaseAssetAmount
		.mul(markPrice)
		.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));

	const effectiveLeverage =
		localBaseAssetValue.sub(netBaseAssetValue).toNumber() /
			(Math.max(0, totalFeeMinusDistributions.toNumber()) + 1) +
		1 / QUOTE_PRECISION.toNumber();

	return effectiveLeverage;
}

export function calculateMaxSpread(marginRatioInitial: number): number {
	const maxTargetSpread: number = new BN(marginRatioInitial)
		.mul(BID_ASK_SPREAD_PRECISION.div(MARGIN_PRECISION))
		.toNumber();

	return maxTargetSpread;
}

export function calculateSpreadBN(
	baseSpread: number,
	lastOracleMarkSpreadPct: BN,
	lastOracleConfPct: BN,
	maxSpread: number,
	quoteAssetReserve: BN,
	terminalQuoteAssetReserve: BN,
	pegMultiplier: BN,
	netBaseAssetAmount: BN,
	markPrice: BN,
	totalFeeMinusDistributions: BN,
	baseAssetReserve: BN,
	minBaseAssetReserve: BN,
	maxBaseAssetReserve: BN
): [number, number] {
	let longSpread = baseSpread / 2;
	let shortSpread = baseSpread / 2;

	if (lastOracleMarkSpreadPct.gt(ZERO)) {
		shortSpread = Math.max(
			shortSpread,
			lastOracleMarkSpreadPct.abs().toNumber() + lastOracleConfPct.toNumber()
		);
	} else if (lastOracleMarkSpreadPct.lt(ZERO)) {
		longSpread = Math.max(
			longSpread,
			lastOracleMarkSpreadPct.abs().toNumber() + lastOracleConfPct.toNumber()
		);
	}

	const maxTargetSpread: number = maxSpread;

	const MAX_INVENTORY_SKEW = 5;

	const inventoryScale = calculateInventoryScale(
		netBaseAssetAmount,
		baseAssetReserve,
		minBaseAssetReserve,
		maxBaseAssetReserve
	);
	const inventorySpreadScale = Math.min(MAX_INVENTORY_SKEW, 1 + inventoryScale);

	if (netBaseAssetAmount.gt(ZERO)) {
		longSpread *= inventorySpreadScale;
	} else if (netBaseAssetAmount.lt(ZERO)) {
		shortSpread *= inventorySpreadScale;
	}

	const effectiveLeverage = calculateEffectiveLeverage(
		baseSpread,
		quoteAssetReserve,
		terminalQuoteAssetReserve,
		pegMultiplier,
		netBaseAssetAmount,
		markPrice,
		totalFeeMinusDistributions
	);

	if (totalFeeMinusDistributions.gt(ZERO)) {
		const spreadScale = Math.min(MAX_INVENTORY_SKEW, 1 + effectiveLeverage);
		if (netBaseAssetAmount.gt(ZERO)) {
			longSpread *= spreadScale;
		} else {
			shortSpread *= spreadScale;
		}
	} else {
		longSpread *= MAX_INVENTORY_SKEW;
		shortSpread *= MAX_INVENTORY_SKEW;
	}

	const totalSpread = longSpread + shortSpread;
	if (totalSpread > maxTargetSpread) {
		if (longSpread > shortSpread) {
			longSpread = Math.min(longSpread, maxTargetSpread);
			shortSpread = maxTargetSpread - longSpread;
		} else {
			shortSpread = Math.min(shortSpread, maxTargetSpread);
			longSpread = maxTargetSpread - shortSpread;
		}
	}

	return [longSpread, shortSpread];
}

export function calculateSpread(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): number {
	if (amm.baseSpread == 0 || amm.curveUpdateIntensity == 0) {
		return amm.baseSpread / 2;
	}

	const markPrice = calculatePrice(
		amm.baseAssetReserve,
		amm.quoteAssetReserve,
		amm.pegMultiplier
	);

	const targetPrice = oraclePriceData?.price || markPrice;
	const confInterval = oraclePriceData.confidence || ZERO;

	const targetMarkSpreadPct = markPrice
		.sub(targetPrice)
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(markPrice);

	const confIntervalPct = confInterval
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(markPrice);

	const [longSpread, shortSpread] = calculateSpreadBN(
		amm.baseSpread,
		targetMarkSpreadPct,
		confIntervalPct,
		amm.maxSpread,
		amm.quoteAssetReserve,
		amm.terminalQuoteAssetReserve,
		amm.pegMultiplier,
		amm.netBaseAssetAmount,
		markPrice,
		amm.totalFeeMinusDistributions,
		amm.baseAssetReserve,
		amm.minBaseAssetReserve,
		amm.maxBaseAssetReserve
	);

	let spread: number;

	if (isVariant(direction, 'long')) {
		spread = longSpread;
	} else {
		spread = shortSpread;
	}

	return spread;
}

export function calculateSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): {
	baseAssetReserve: BN;
	quoteAssetReserve: BN;
} {
	const spread = calculateSpread(amm, direction, oraclePriceData);

	if (spread === 0) {
		return {
			baseAssetReserve: amm.baseAssetReserve,
			quoteAssetReserve: amm.quoteAssetReserve,
		};
	}

	const quoteAsserReserveDelta = amm.quoteAssetReserve.div(
		BID_ASK_SPREAD_PRECISION.div(new BN(spread / 2))
	);

	let quoteAssetReserve;
	if (isVariant(direction, 'long')) {
		quoteAssetReserve = amm.quoteAssetReserve.add(quoteAsserReserveDelta);
	} else {
		quoteAssetReserve = amm.quoteAssetReserve.sub(quoteAsserReserveDelta);
	}

	const baseAssetReserve = amm.sqrtK.mul(amm.sqrtK).div(quoteAssetReserve);
	return {
		baseAssetReserve,
		quoteAssetReserve,
	};
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
 * @returns cost : Precision MARK_PRICE_PRECISION
 */
export function calculateTerminalPrice(market: PerpMarketAccount) {
	const directionToClose = market.amm.netBaseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.amm.netBaseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);

	const terminalPrice = newQuoteAssetReserve
		.mul(MARK_PRICE_PRECISION)
		.mul(market.amm.pegMultiplier)
		.div(PEG_PRECISION)
		.div(newBaseAssetReserve);

	return terminalPrice;
}

export function calculateMaxBaseAssetAmountToTrade(
	amm: AMM,
	limit_price: BN,
	direction: PositionDirection,
	oraclePriceData?: OraclePriceData
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(MARK_PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(newBaseAssetReserveSquared);

	const baseAssetReserveBefore = calculateSpreadReserves(
		amm,
		direction,
		oraclePriceData
	).baseAssetReserve;

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
		new BN(amm.maxBaseAssetAmountRatio)
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
		amm.baseAssetAmountStepSize
	);
}
