import {
	HistoricalOracleData,
	MarketStats,
	OracleGuardRails,
	OracleSource,
	OracleValidity,
	PerpMarketAccount,
	isOneOfVariant,
	isVariant,
} from '../types';
import { OraclePriceData } from '../oracles/types';
import {
	BID_ASK_SPREAD_PRECISION,
	MARGIN_PRECISION,
	ONE,
	ZERO,
	FIVE_MINUTE,
	PERCENTAGE_PRECISION,
	FIVE,
} from '../constants/numericConstants';
import { assert } from '../assert/assert';
import { BN } from '../isomorphic/anchor';

export function oraclePriceBands(
	market: PerpMarketAccount,
	oraclePriceData: Pick<OraclePriceData, 'price'>
): [BN, BN] {
	const maxPercentDiff =
		market.marginRatioInitial - market.marginRatioMaintenance;
	const offset = oraclePriceData.price
		.mul(new BN(maxPercentDiff))
		.div(MARGIN_PRECISION);

	assert(offset.gte(ZERO));

	return [oraclePriceData.price.sub(offset), oraclePriceData.price.add(offset)];
}

export function getMaxConfidenceIntervalMultiplier(
	market: PerpMarketAccount
): BN {
	let maxConfidenceIntervalMultiplier;
	if (isVariant(market.contractTier, 'a')) {
		maxConfidenceIntervalMultiplier = new BN(1);
	} else if (isVariant(market.contractTier, 'b')) {
		maxConfidenceIntervalMultiplier = new BN(1);
	} else if (isVariant(market.contractTier, 'c')) {
		maxConfidenceIntervalMultiplier = new BN(2);
	} else if (isVariant(market.contractTier, 'speculative')) {
		maxConfidenceIntervalMultiplier = new BN(10);
	} else {
		maxConfidenceIntervalMultiplier = new BN(50);
	}
	return maxConfidenceIntervalMultiplier;
}

export function getOracleValidity(
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	slot: BN,
	oracleStalenessBuffer = FIVE
): OracleValidity {
	const isNonPositive = oraclePriceData.price.lte(ZERO);
	const isTooVolatile = BN.max(
		oraclePriceData.price,
		market.marketStats.historicalOracleData.lastOraclePriceTwap
	)
		.div(
			BN.max(
				ONE,
				BN.min(
					oraclePriceData.price,
					market.marketStats.historicalOracleData.lastOraclePriceTwap
				)
			)
		)
		.gt(oracleGuardRails.validity.tooVolatileRatio);

	const confPctOfPrice = oraclePriceData.confidence
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(oraclePriceData.price);
	const isConfTooLarge = confPctOfPrice.gt(
		oracleGuardRails.validity.confidenceIntervalMaxSize.mul(
			getMaxConfidenceIntervalMultiplier(market)
		)
	);

	const oracleDelay = slot.sub(oraclePriceData.slot).sub(oracleStalenessBuffer);

	let isStaleForAmmImmediate = true;
	if (market.oracleSlotDelayOverride != 0) {
		isStaleForAmmImmediate = oracleDelay.gt(
			BN.max(new BN(market.oracleSlotDelayOverride), ZERO)
		);
	}

	let isStaleForAmmLowRisk = false;
	if (market.oracleLowRiskSlotDelayOverride != 0) {
		isStaleForAmmLowRisk = oracleDelay.gt(
			BN.max(new BN(market.oracleLowRiskSlotDelayOverride), ZERO)
		);
	} else {
		isStaleForAmmLowRisk = oracleDelay.gt(
			oracleGuardRails.validity.slotsBeforeStaleForAmm
		);
	}

	let isStaleForMargin = oracleDelay.gt(
		new BN(oracleGuardRails.validity.slotsBeforeStaleForMargin)
	);
	if (isVariant(market.oracleSource, 'pythLazerStableCoin')) {
		isStaleForMargin = oracleDelay.gt(
			new BN(oracleGuardRails.validity.slotsBeforeStaleForMargin).muln(3)
		);
	}

	if (isNonPositive) {
		return OracleValidity.NonPositive;
	} else if (isTooVolatile) {
		return OracleValidity.TooVolatile;
	} else if (isConfTooLarge) {
		return OracleValidity.TooUncertain;
	} else if (isStaleForMargin) {
		return OracleValidity.StaleForMargin;
	} else if (!oraclePriceData.hasSufficientNumberOfDataPoints) {
		return OracleValidity.InsufficientDataPoints;
	} else if (isStaleForAmmLowRisk) {
		return OracleValidity.StaleForAMMLowRisk;
	} else if (isStaleForAmmImmediate) {
		return OracleValidity.isStaleForAmmImmediate;
	} else {
		return OracleValidity.Valid;
	}
}

export function isOracleValid(
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	slot: number
): boolean {
	// checks if oracle is valid for an AMM only fill

	const stats = market.marketStats;
	const isOraclePriceNonPositive = oraclePriceData.price.lte(ZERO);
	const isOraclePriceTooVolatile =
		oraclePriceData.price
			.div(BN.max(ONE, stats.historicalOracleData.lastOraclePriceTwap))
			.gt(oracleGuardRails.validity.tooVolatileRatio) ||
		stats.historicalOracleData.lastOraclePriceTwap
			.div(BN.max(ONE, oraclePriceData.price))
			.gt(oracleGuardRails.validity.tooVolatileRatio);

	const maxConfidenceIntervalMultiplier =
		getMaxConfidenceIntervalMultiplier(market);
	const isConfidenceTooLarge = BN.max(ONE, oraclePriceData.confidence)
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(oraclePriceData.price)
		.gt(
			oracleGuardRails.validity.confidenceIntervalMaxSize.mul(
				maxConfidenceIntervalMultiplier
			)
		);

	const oracleIsStale = new BN(slot)
		.sub(oraclePriceData.slot)
		.gt(oracleGuardRails.validity.slotsBeforeStaleForAmm);

	return !(
		!oraclePriceData.hasSufficientNumberOfDataPoints ||
		oracleIsStale ||
		isOraclePriceNonPositive ||
		isOraclePriceTooVolatile ||
		isConfidenceTooLarge
	);
}

export function isOracleTooDivergent(
	marketStats: MarketStats,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails
): boolean {
	const oracleSpreadPct = oraclePriceData.price
		.sub(marketStats.historicalOracleData.lastOraclePriceTwap5Min)
		.mul(PERCENTAGE_PRECISION)
		.div(marketStats.historicalOracleData.lastOraclePriceTwap5Min);
	const maxDivergence = BN.max(
		oracleGuardRails.priceDivergence.oracleTwap5MinPercentDivergence,
		PERCENTAGE_PRECISION.div(new BN(2))
	);
	const tooDivergent = oracleSpreadPct.abs().gte(maxDivergence);
	return tooDivergent;
}

export function calculateLiveOracleTwap(
	histOracleData: HistoricalOracleData,
	oraclePriceData: OraclePriceData,
	now: BN,
	period: BN
): BN {
	let oracleTwap = undefined;
	if (period.eq(FIVE_MINUTE)) {
		oracleTwap = histOracleData.lastOraclePriceTwap5Min;
	} else {
		//todo: assumes its fundingPeriod (1hr)
		// period = amm.fundingPeriod;
		oracleTwap = histOracleData.lastOraclePriceTwap;
	}

	const sinceLastUpdate = BN.max(
		ONE,
		now.sub(histOracleData.lastOraclePriceTwapTs)
	);
	const sinceStart = BN.max(ZERO, period.sub(sinceLastUpdate));

	const clampRange = oracleTwap.div(new BN(3));

	const clampedOraclePrice = BN.min(
		oracleTwap.add(clampRange),
		BN.max(oraclePriceData.price, oracleTwap.sub(clampRange))
	);

	const newOracleTwap = oracleTwap
		.mul(sinceStart)
		.add(clampedOraclePrice.mul(sinceLastUpdate))
		.div(sinceStart.add(sinceLastUpdate));

	return newOracleTwap;
}

export function calculateLiveOracleStd(
	marketStats: MarketStats,
	oraclePriceData: OraclePriceData,
	now: BN
): BN {
	const sinceLastUpdate = BN.max(
		ONE,
		now.sub(marketStats.historicalOracleData.lastOraclePriceTwapTs)
	);
	const sinceStart = BN.max(
		ZERO,
		marketStats.fundingPeriod.sub(sinceLastUpdate)
	);

	const liveOracleTwap = calculateLiveOracleTwap(
		marketStats.historicalOracleData,
		oraclePriceData,
		now,
		marketStats.fundingPeriod
	);

	const liveOracleTwap5MIN = calculateLiveOracleTwap(
		marketStats.historicalOracleData,
		oraclePriceData,
		now,
		FIVE_MINUTE
	);

	const priceDeltaVsTwap = BN.max(
		oraclePriceData.price.sub(liveOracleTwap).abs(),
		oraclePriceData.price.sub(liveOracleTwap5MIN).abs()
	);

	const oracleStd = priceDeltaVsTwap.add(
		marketStats.oracleStd.mul(sinceStart).div(sinceStart.add(sinceLastUpdate))
	);

	return oracleStd;
}

export function getNewOracleConfPct(
	marketStats: MarketStats,
	oraclePriceData: OraclePriceData,
	reservePrice: BN,
	now: BN
): BN {
	const confInterval = oraclePriceData.confidence || ZERO;

	const sinceLastUpdate = BN.max(
		ZERO,
		now.sub(marketStats.historicalOracleData.lastOraclePriceTwapTs)
	);
	let lowerBoundConfPct = marketStats.lastOracleConfPct;
	if (sinceLastUpdate.gt(ZERO)) {
		const lowerBoundConfDivisor = BN.max(
			new BN(21).sub(sinceLastUpdate),
			new BN(5)
		);
		lowerBoundConfPct = marketStats.lastOracleConfPct.sub(
			marketStats.lastOracleConfPct.div(lowerBoundConfDivisor)
		);
	}
	const confIntervalPct = confInterval
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(reservePrice);

	const confIntervalPctResult = BN.max(confIntervalPct, lowerBoundConfPct);

	return confIntervalPctResult;
}

export function trimVaaSignatures(vaa: Buffer, n = 3): Buffer {
	const currentNumSignatures = vaa[5];
	if (n > currentNumSignatures) {
		throw new Error(
			"Resulting VAA can't have more signatures than the original VAA"
		);
	}

	const trimmedVaa = Buffer.concat([
		vaa.subarray(0, 6 + n * 66),
		vaa.subarray(6 + currentNumSignatures * 66),
	]);

	trimmedVaa[5] = n;
	return trimmedVaa;
}

export function getMultipleBetweenOracleSources(
	firstOracleSource: OracleSource,
	secondOracleSource: OracleSource
): { numerator: BN; denominator: BN } {
	if (
		isOneOfVariant(firstOracleSource, [
			'pythPull',
			'pyth1KPull',
			'pyth1MPull',
			'pythStableCoinPull',
		]) ||
		isOneOfVariant(secondOracleSource, [
			'pythPull',
			'pyth1KPull',
			'pyth1MPull',
			'pythStableCoinPull',
		])
	) {
		throw new Error('Pyth pull oracle support has been removed from the SDK');
	}

	if (
		isVariant(firstOracleSource, 'pythLazer') &&
		isVariant(secondOracleSource, 'pythLazer1M')
	) {
		return { numerator: new BN(1000000), denominator: new BN(1) };
	}

	if (
		isVariant(firstOracleSource, 'pythLazer') &&
		isVariant(secondOracleSource, 'pythLazer1K')
	) {
		return { numerator: new BN(1000), denominator: new BN(1) };
	}

	if (
		isVariant(firstOracleSource, 'pythLazer1M') &&
		isVariant(secondOracleSource, 'pythLazer')
	) {
		return { numerator: new BN(1), denominator: new BN(1000000) };
	}

	if (
		isVariant(firstOracleSource, 'pythLazer1K') &&
		isVariant(secondOracleSource, 'pythLazer')
	) {
		return { numerator: new BN(1), denominator: new BN(1000) };
	}

	return { numerator: new BN(1), denominator: new BN(1) };
}
