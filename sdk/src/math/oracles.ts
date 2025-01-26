import { AMM, OracleGuardRails, isVariant } from '../types';
import { OraclePriceData } from '../oracles/types';
import {
	BID_ASK_SPREAD_PRECISION,
	MARGIN_PRECISION,
	PRICE_PRECISION,
	ONE,
	ZERO,
	FIVE_MINUTE,
	PERCENTAGE_PRECISION,
} from '../constants/numericConstants';
import {
	BN,
	HistoricalOracleData,
	OracleSource,
	PerpMarketAccount,
} from '../index';
import { assert } from '../assert/assert';

export function oraclePriceBands(
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData
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

export function isOracleValid(
	market: PerpMarketAccount,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	slot: number
): boolean {
	// checks if oracle is valid for an AMM only fill

	const amm = market.amm;
	const isOraclePriceNonPositive = oraclePriceData.price.lte(ZERO);
	const isOraclePriceTooVolatile =
		oraclePriceData.price
			.div(BN.max(ONE, amm.historicalOracleData.lastOraclePriceTwap))
			.gt(oracleGuardRails.validity.tooVolatileRatio) ||
		amm.historicalOracleData.lastOraclePriceTwap
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
	amm: AMM,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	now: BN
): boolean {
	const sinceLastUpdate = now.sub(
		amm.historicalOracleData.lastOraclePriceTwapTs
	);
	const sinceStart = BN.max(ZERO, FIVE_MINUTE.sub(sinceLastUpdate));
	const oracleTwap5min = amm.historicalOracleData.lastOraclePriceTwap5Min
		.mul(sinceStart)
		.add(oraclePriceData.price)
		.mul(sinceLastUpdate)
		.div(sinceStart.add(sinceLastUpdate));

	const oracleSpread = oracleTwap5min.sub(oraclePriceData.price);
	const oracleSpreadPct = oracleSpread.mul(PRICE_PRECISION).div(oracleTwap5min);

	const maxDivergence = BN.max(
		oracleGuardRails.priceDivergence.markOraclePercentDivergence,
		PERCENTAGE_PRECISION.div(new BN(10))
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
	amm: AMM,
	oraclePriceData: OraclePriceData,
	now: BN
): BN {
	const sinceLastUpdate = BN.max(
		ONE,
		now.sub(amm.historicalOracleData.lastOraclePriceTwapTs)
	);
	const sinceStart = BN.max(ZERO, amm.fundingPeriod.sub(sinceLastUpdate));

	const liveOracleTwap = calculateLiveOracleTwap(
		amm.historicalOracleData,
		oraclePriceData,
		now,
		amm.fundingPeriod
	);

	const priceDeltaVsTwap = oraclePriceData.price.sub(liveOracleTwap).abs();

	const oracleStd = priceDeltaVsTwap.add(
		amm.oracleStd.mul(sinceStart).div(sinceStart.add(sinceLastUpdate))
	);

	return oracleStd;
}

export function getNewOracleConfPct(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	reservePrice: BN,
	now: BN
): BN {
	const confInterval = oraclePriceData.confidence || ZERO;

	const sinceLastUpdate = BN.max(
		ZERO,
		now.sub(amm.historicalOracleData.lastOraclePriceTwapTs)
	);
	let lowerBoundConfPct = amm.lastOracleConfPct;
	if (sinceLastUpdate.gt(ZERO)) {
		const lowerBoundConfDivisor = BN.max(
			new BN(21).sub(sinceLastUpdate),
			new BN(5)
		);
		lowerBoundConfPct = amm.lastOracleConfPct.sub(
			amm.lastOracleConfPct.div(lowerBoundConfDivisor)
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
		isVariant(firstOracleSource, 'pythPull') &&
		isVariant(secondOracleSource, 'pyth1MPull')
	) {
		return { numerator: new BN(1000000), denominator: new BN(1) };
	}

	if (
		isVariant(firstOracleSource, 'pythPull') &&
		isVariant(secondOracleSource, 'pyth1KPull')
	) {
		return { numerator: new BN(1000), denominator: new BN(1) };
	}

	if (
		isVariant(firstOracleSource, 'pyth1MPull') &&
		isVariant(secondOracleSource, 'pythPull')
	) {
		return { numerator: new BN(1), denominator: new BN(1000000) };
	}

	if (
		isVariant(firstOracleSource, 'pyth1KPull') &&
		isVariant(secondOracleSource, 'pythPull')
	) {
		return { numerator: new BN(1), denominator: new BN(1000) };
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
