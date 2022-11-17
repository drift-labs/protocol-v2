import { AMM, OracleGuardRails } from '../types';
import { OraclePriceData } from '../oracles/types';
import {
	BID_ASK_SPREAD_PRECISION,
	MARGIN_PRECISION,
	PRICE_PRECISION,
	ONE,
	ZERO,
} from '../constants/numericConstants';
import { BN, PerpMarketAccount } from '../index';
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

	const isConfidenceTooLarge = new BN(amm.baseSpread)
		.add(BN.max(ONE, oraclePriceData.confidence))
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(oraclePriceData.price)
		.gt(new BN(amm.maxSpread));

	const oracleIsStale = oraclePriceData.slot
		.sub(new BN(slot))
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
	const sinceStart = BN.max(ZERO, new BN(60 * 5).sub(sinceLastUpdate));
	const oracleTwap5min = amm.historicalOracleData.lastOraclePriceTwap5Min
		.mul(sinceStart)
		.add(oraclePriceData.price)
		.mul(sinceLastUpdate)
		.div(sinceStart.add(sinceLastUpdate));

	const oracleSpread = oracleTwap5min.sub(oraclePriceData.price);
	const oracleSpreadPct = oracleSpread.mul(PRICE_PRECISION).div(oracleTwap5min);

	const tooDivergent = oracleSpreadPct
		.abs()
		.gte(
			BID_ASK_SPREAD_PRECISION.mul(
				oracleGuardRails.priceDivergence.markOracleDivergenceNumerator
			).div(oracleGuardRails.priceDivergence.markOracleDivergenceDenominator)
		);

	return tooDivergent;
}

export function calculateLiveOracleTwap(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	now: BN
): BN {
	const sinceLastUpdate = now.sub(
		amm.historicalOracleData.lastOraclePriceTwapTs
	);
	const sinceStart = BN.max(ZERO, amm.fundingPeriod.sub(sinceLastUpdate));

	const clampRange = amm.historicalOracleData.lastOraclePriceTwap.div(
		new BN(3)
	);

	const clampedOraclePrice = BN.min(
		amm.historicalOracleData.lastOraclePriceTwap.add(clampRange),
		BN.max(
			oraclePriceData.price,
			amm.historicalOracleData.lastOraclePriceTwap.sub(clampRange)
		)
	);

	const newOracleTwap = amm.historicalOracleData.lastOraclePriceTwap
		.mul(sinceStart)
		.add(clampedOraclePrice)
		.mul(sinceLastUpdate)
		.div(sinceStart.add(sinceLastUpdate));

	return newOracleTwap;
}

export function calculateLiveOracleStd(
	amm: AMM,
	oraclePriceData: OraclePriceData,
	now: BN
): BN {
	const sinceLastUpdate = now.sub(
		amm.historicalOracleData.lastOraclePriceTwapTs
	);
	const sinceStart = BN.max(ZERO, amm.fundingPeriod.sub(sinceLastUpdate));

	const liveOracleTwap = calculateLiveOracleTwap(amm, oraclePriceData, now);

	const priceDeltaVsTwap = oraclePriceData.price.sub(liveOracleTwap).abs();

	const oracleStd = priceDeltaVsTwap.add(
		amm.oracleStd.mul(sinceStart).div(sinceStart.add(sinceLastUpdate))
	);

	return oracleStd;
}
