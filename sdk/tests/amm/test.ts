import {
	BN,
	PEG_PRECISION,
	PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	calculateSpreadBN,
	ZERO,
	calculateLiveOracleStd,
	calculateLiveOracleTwap,
} from '../../src';
import { mockPerpMarkets } from '../dlob/helpers';

import { assert } from '../../src/assert/assert';

class AMMSpreadTerms {
	longVolSpread: number;
	shortVolSpread: number;
	longSpreadwPS: number;
	shortSpreadwPS: number;
	maxTargetSpread: number;
	inventorySpreadScale: number;
	longSpreadwInvScale: number;
	shortSpreadwInvScale: number;
	effectiveLeverage: number;
	effectiveLeverageCapped: number;
	longSpreadwEL: number;
	shortSpreadwEL: number;
	revenueRetreatAmount: number;
	halfRevenueRetreatAmount: number;
	longSpreadwRevRetreat: number;
	shortSpreadwRevRetreat: number;
	totalSpread: number;
	longSpread: number;
	shortSpread: number;
}

describe('AMM Tests', () => {
	it('Various Spreads', () => {
		const baseSpread: number = 0.025 * 1e6;
		const lastOracleReservePriceSpreadPct: BN = ZERO;
		const lastOracleConfPct: BN = ZERO;
		const maxSpread: number = 0.03 * 1e6;
		const quoteAssetReserve: BN = new BN(
			AMM_RESERVE_PRECISION.toNumber() * 100
		);
		const terminalQuoteAssetReserve: BN = new BN(
			AMM_RESERVE_PRECISION.toNumber() * 100
		);
		const pegMultiplier: BN = new BN(13.455 * PEG_PRECISION.toNumber());
		const baseAssetAmountWithAmm: BN = ZERO;
		const reservePrice: BN = new BN(13.455 * PRICE_PRECISION.toNumber());
		const totalFeeMinusDistributions: BN = new BN(1);
		const netRevenueSinceLastFunding: BN = new BN(
			QUOTE_PRECISION.toNumber() * 2
		);
		const baseAssetReserve: BN = new BN(AMM_RESERVE_PRECISION.toNumber() * 100);
		const minBaseAssetReserve: BN = new BN(
			AMM_RESERVE_PRECISION.toNumber() * 90
		);
		const maxBaseAssetReserve: BN = new BN(
			AMM_RESERVE_PRECISION.toNumber() * 110
		);
		const markStd: BN = new BN(0.45 * PRICE_PRECISION.toNumber());
		const oracleStd: BN = new BN(0.55 * PRICE_PRECISION.toNumber());
		const longIntensity: BN = new BN(QUOTE_PRECISION.toNumber() * 20);
		const shortIntensity: BN = new BN(QUOTE_PRECISION.toNumber() * 2);
		const volume24H: BN = new BN(QUOTE_PRECISION.toNumber() * 25);

		const spreads = calculateSpreadBN(
			baseSpread,
			lastOracleReservePriceSpreadPct,
			lastOracleConfPct,
			maxSpread,
			quoteAssetReserve,
			terminalQuoteAssetReserve,
			pegMultiplier,
			baseAssetAmountWithAmm,
			reservePrice,
			totalFeeMinusDistributions,
			netRevenueSinceLastFunding,
			baseAssetReserve,
			minBaseAssetReserve,
			maxBaseAssetReserve,
			markStd,
			oracleStd,
			longIntensity,
			shortIntensity,
			volume24H
		);
		const l1 = spreads[0];
		const s1 = spreads[1];

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const terms1: AMMSpreadTerms = calculateSpreadBN(
			baseSpread,
			lastOracleReservePriceSpreadPct,
			lastOracleConfPct,
			maxSpread,
			quoteAssetReserve,
			terminalQuoteAssetReserve,
			pegMultiplier,
			baseAssetAmountWithAmm,
			reservePrice,
			totalFeeMinusDistributions,
			netRevenueSinceLastFunding,
			baseAssetReserve,
			minBaseAssetReserve,
			maxBaseAssetReserve,
			markStd,
			oracleStd,
			longIntensity,
			shortIntensity,
			volume24H,
			true
		);
		console.log(terms1);

		console.log('long/short spread:', l1, s1);
		assert(l1 == 14864);
		assert(s1 == 12500);
		assert(l1 == terms1.longSpread);
		assert(s1 == terms1.shortSpread);

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const terms2: AMMSpreadTerms = calculateSpreadBN(
			300,
			new BN(0),
			new BN(484),
			47500,
			new BN(923807816209694),
			new BN(925117623772584),
			new BN(13731157),
			new BN(-1314027016625),
			new BN(13667686),
			new BN(115876379475),
			new BN(91316628),
			new BN(928097825691666),
			new BN(907979542352912),
			new BN(945977491145601),
			new BN(161188),
			new BN(1459632439),
			new BN(12358265776),
			new BN(72230366233),
			new BN(432067603632),
			true
		);

		console.log(terms2);
		assert(terms2.effectiveLeverageCapped >= 1.0002);
		assert(terms2.inventorySpreadScale == 10);
		assert(terms2.longSpread == 798);
		assert(terms2.shortSpread == 46702);
	});

	it('Corner Case Spreads', () => {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const terms2: AMMSpreadTerms = calculateSpreadBN(
			1000,
			new BN(5555),
			new BN(1131),
			20000,
			new BN(1009967115003047),
			new BN(1009811402660255),
			new BN(13460124),
			new BN(15328930153),
			new BN(13667686),
			new BN(1235066973),
			new BN(88540713),
			new BN(994097717724176),
			new BN(974077854655784),
			new BN(1014841945381208),
			new BN(103320),
			new BN(59975),
			new BN(768323534),
			new BN(243875031),
			new BN(130017761029),
			true
		);

		console.log(terms2);
		assert(terms2.effectiveLeverageCapped <= 1.000001);
		assert(terms2.inventorySpreadScale == 1.117371);
		assert(terms2.longSpread == 1263);
		assert(terms2.shortSpread == 6686);
	});

	it('live update functions', () => {
		const mockAmm = mockPerpMarkets[0].amm;
		const now = new BN(new Date().getTime() / 1000); //todo

		const oraclePriceData = {
			price: new BN(13.553 * PRICE_PRECISION.toNumber()),
			slot: new BN(68 + 1),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
		};
		mockAmm.oracleStd = new BN(0.18 * PRICE_PRECISION.toNumber());
		mockAmm.fundingPeriod = new BN(3600);
		mockAmm.historicalOracleData.lastOraclePriceTwap = oraclePriceData.price
			.mul(new BN(999))
			.div(new BN(1000));
		mockAmm.historicalOracleData.lastOraclePriceTwapTs = now.sub(new BN(11));

		const liveOracleTwap = calculateLiveOracleTwap(
			mockAmm,
			oraclePriceData,
			now
		);
		console.log('liveOracleTwap:', liveOracleTwap.toNumber());
		assert(liveOracleTwap.eq(new BN(13539488)));

		const liveOracleStd = calculateLiveOracleStd(mockAmm, oraclePriceData, now);
		console.log('liveOracleStd:', liveOracleStd.toNumber());
		assert(liveOracleStd.eq(new BN(192962)));
	});
});
