import { AMM, OracleGuardRails } from '../types';
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
import { BN, HistoricalOracleData, PerpMarketAccount } from '../index';
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

	assert(offset.gt(ZERO));

	return [oraclePriceData.price.sub(offset), oraclePriceData.price.add(offset)];
}

export function isOracleValid(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	oracleGuardRails: OracleGuardRails,
	slot: number
): boolean {
	const isOraclePriceNonPositive = oraclePriceData.price.lte(ZERO);
	const isOraclePriceTooVolatile =
		oraclePriceData.price
			.div(BN.max(ONE, amm.historicalOracleData.lastOraclePriceTwap))
			.gt(oracleGuardRails.validity.tooVolatileRatio) ||
		amm.historicalOracleData.lastOraclePriceTwap
			.div(BN.max(ONE, oraclePriceData.price))
			.gt(oracleGuardRails.validity.tooVolatileRatio);

	const isConfidenceTooLarge = BN.max(ONE, oraclePriceData.confidence)
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(oraclePriceData.price)
		.gt(oracleGuardRails.validity.confidenceIntervalMaxSize);

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
