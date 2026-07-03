import {
	BN,
	PEG_PRECISION,
	PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	PERCENTAGE_PRECISION,
	calculateSpread,
	calculateSpreadBN,
	calculateSpreadFundingBiasScale,
	ZERO,
	sigNum,
	ONE,
	calculateLiveOracleStd,
	calculateLiveOracleTwap,
	calculateInventoryScale,
	calculateAllEstimatedFundingRate,
	calculateLongShortFundingRateAndLiveTwaps,
	getVammL2Generator,
	BASE_PRECISION,
	PerpMarketAccount,
	L2Level,
	calculateUpdatedAMM,
	calculateMarketOpenBidAsk,
	calculateSpreadReserves,
	calculatePrice,
	BID_ASK_SPREAD_PRECISION,
	squareRootBN,
	calculateReferencePriceOffset,
	calculateInventoryLiquidityRatio,
	ContractTier,
	isOracleValid,
	OracleGuardRails,
	getNewOracleConfPct,
	MMOraclePriceData,
	OraclePriceData,
	calculateAmmReservesAfterSwap,
	getSwapDirection,
	PositionDirection,
	// calculateReservePrice,
} from '../../src';
import { mockPerpMarkets } from '../dlob/helpers';

import { assert } from '../../src/assert/assert';
import * as _ from 'lodash';

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
	fundingBiasScale: number;
	longSpreadwFundingBias: number;
	shortSpreadwFundingBias: number;
	totalSpread: number;
	longSpread: number;
	shortSpread: number;
}

describe('AMM Tests', () => {
	it('Spread Maths', () => {
		let iscale = calculateInventoryScale(
			ZERO,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		assert(iscale == 1);

		iscale = calculateInventoryScale(
			ONE,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		assert(iscale == 1);

		let baa = new BN(1000);
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		console.log(iscale);
		assert(iscale == 1.00024);

		baa = new BN(100000);
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		console.log(iscale);
		assert(iscale == 1.024);

		baa = new BN(1000000);
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		console.log(iscale);
		assert(iscale == 1.24048);

		baa = new BN(10000000); // 2%
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		console.log(iscale);
		assert(iscale == 3.44896);

		baa = new BN(50000000); // 10%
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		console.log(iscale);
		assert(iscale == 14.33332);

		baa = AMM_RESERVE_PRECISION.div(new BN(4)); // 50%
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		console.log(iscale);
		assert(iscale == 120); //100%

		baa = AMM_RESERVE_PRECISION.div(new BN(4)); // 50%
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000 * 2
		);
		console.log(iscale);
		assert(iscale == 120 * 2); //100%

		baa = AMM_RESERVE_PRECISION.div(new BN(5)); // <50%
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000 * 2
		);
		assert(iscale == 160.99984);

		baa = new BN(855329058);
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION,
			250,
			30000
		); // >100%
		assert(iscale == 120);
		assert(250 * iscale == 30000);

		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa), // ~85%
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		assert(iscale == 120);
		assert(250 * iscale == 30000);

		baa = new BN(-855329058); // ~85%
		iscale = calculateInventoryScale(
			baa,
			AMM_RESERVE_PRECISION.add(baa),
			AMM_RESERVE_PRECISION.div(new BN(2)),
			AMM_RESERVE_PRECISION.mul(new BN(3)).div(new BN(2)),
			250,
			30000
		);
		assert(iscale == 120);
		assert(250 * iscale == 30000);

		// 'bonk' scale
		iscale = calculateInventoryScale(
			new BN('30228000000000000'),
			new BN('2496788386034912600'),
			new BN('2443167585342470000'),
			new BN('2545411471321696000'),
			3500,
			100000
		);
		console.log(iscale);
		console.log((3500 * iscale) / 1e6);
		assert(iscale == 18.762285);
		assert((3500 * iscale) / 1e6 == 0.06566799749999999); //6.5%
	});

	it('Funding Bias Scale', () => {
		// values pinned to the program's calculate_spread_funding_bias_scale tests
		const twap = new BN(100).mul(PRICE_PRECISION); // $100
		// hourly rate matching the funding offset floor f_ref (~10.95%/yr):
		// fNorm = 1_250_000 * 1e6 / 1e8 * 24 = 300_000
		const saturatingRate = new BN(1_250_000);
		const qAmmLong = BASE_PRECISION.neg(); // users net short
		const qAmmShort = BASE_PRECISION; // users net long
		const one = BID_ASK_SPREAD_PRECISION.toNumber();

		// s = 0 disables
		assert(
			calculateSpreadFundingBiasScale(qAmmLong, saturatingRate, twap, 0) == one
		);

		// f * q >= 0: vAMM receives (or zero rate/inventory), β = 1
		assert(
			calculateSpreadFundingBiasScale(qAmmShort, saturatingRate, twap, 50) ==
				one
		);
		assert(
			calculateSpreadFundingBiasScale(
				qAmmLong,
				saturatingRate.neg(),
				twap,
				50
			) == one
		);
		assert(
			calculateSpreadFundingBiasScale(ZERO, saturatingRate, twap, 50) == one
		);
		assert(calculateSpreadFundingBiasScale(qAmmLong, ZERO, twap, 50) == one);

		// paying at f_ref: ρ ~= 1, β ~= 1 + s/100
		assert(
			calculateSpreadFundingBiasScale(qAmmLong, saturatingRate, twap, 50) ==
				1_499_950
		);
		assert(
			calculateSpreadFundingBiasScale(
				qAmmShort,
				saturatingRate.neg(),
				twap,
				50
			) == 1_499_950
		);

		// half ramp: β = 1 + s/100 * 0.5
		assert(
			calculateSpreadFundingBiasScale(
				qAmmLong,
				saturatingRate.divn(2),
				twap,
				50
			) == 1_249_975
		);

		// past f_ref the ramp clamps at 1: β = 1 + s/100 exactly
		assert(
			calculateSpreadFundingBiasScale(
				qAmmLong,
				saturatingRate.muln(10),
				twap,
				100
			) ==
				2 * one
		);

		// integration: paying side doubles at s = 100, other side untouched,
		// mirrors the program's calculate_spread_funding_bias_tests
		const calc = (rate: BN, s: number) =>
			calculateSpreadBN(
				1000, // baseSpread
				ZERO,
				ZERO,
				2000, // maxSpread
				AMM_RESERVE_PRECISION.muln(10),
				AMM_RESERVE_PRECISION.muln(10),
				new BN(34000000),
				new BN(-1000), // tiny vAMM-long inventory so σ = λ = 1
				new BN(34562304),
				QUOTE_PRECISION.muln(10),
				ZERO,
				AMM_RESERVE_PRECISION.muln(10),
				ZERO,
				AMM_RESERVE_PRECISION.muln(100000),
				ZERO,
				ZERO,
				ZERO,
				ZERO,
				ZERO,
				0,
				rate,
				twap,
				s
			) as [number, number];

		const [long0, short0] = calc(saturatingRate.muln(10), 0);
		assert(long0 == 500);
		assert(short0 == 500);

		const [long1, short1] = calc(saturatingRate.muln(10), 100);
		assert(long1 == long0);
		assert(short1 == short0 * 2);

		const [long2, short2] = calc(saturatingRate.muln(10).neg(), 100);
		assert(long2 == long0);
		assert(short2 == short0);
	});

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
			volume24H,
			0
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
			0,
			ZERO,
			ZERO,
			0,
			true
		);
		// console.log(terms1);

		console.log('long/short spread:', l1, s1);
		assert(l1 == 12500);
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
			new BN(161188), // mark std
			new BN(145963), // oracle std
			new BN(12358265776),
			new BN(72230366233),
			new BN(432067603632),
			0,
			ZERO,
			ZERO,
			0,
			true
		);

		assert(terms2.effectiveLeverageCapped >= 1.0002);
		assert(terms2.inventorySpreadScale == 8.443219);
		assert(terms2.longSpread == 150);
		assert(terms2.shortSpread == 3960);

		// add spread offset
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const terms3: AMMSpreadTerms = calculateSpreadBN(
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
			new BN(145963), // oracle std
			new BN(12358265776),
			new BN(72230366233),
			new BN(432067603632),
			0,
			ZERO,
			ZERO,
			0,
			true
		);

		// console.log(terms3);
		assert(terms3.effectiveLeverageCapped >= 1.0002);
		assert(terms3.inventorySpreadScale == 8.443219);
		assert(terms3.longSpread == 150);
		assert(terms3.shortSpread == 3960);
		assert(terms3.longSpread + terms3.shortSpread == 3960 + 150);

		// add spread offset
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const terms4: AMMSpreadTerms = calculateSpreadBN(
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
			new BN(1459632439), // oracle std (unchanged)
			new BN(12358265776),
			new BN(72230366233),
			new BN(432067603632),
			0,
			ZERO,
			ZERO,
			0,
			true
		);

		assert(terms4.effectiveLeverageCapped >= 1.0002);
		assert(terms4.inventorySpreadScale == 1.73492);
		assert(terms4.longSpread == 89746);
		assert(terms4.shortSpread == 910254);
		assert(terms4.longSpread + terms4.shortSpread == 1000000);
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
			0,
			ZERO,
			ZERO,
			0,
			true
		);

		assert(terms2.effectiveLeverageCapped <= 1.000001);
		assert(terms2.inventorySpreadScale == 1.0306);
		assert(terms2.longSpread == 515);
		assert(terms2.shortSpread == 5611);

		const suiExample = {
			status: 'active',
			contractType: 'perpetual',
			contractTier: 'c',
			expiryTs: '0',
			expiryPrice: '0',
			marketIndex: 9,
			pubkey: '91NsaUmTNNdLGbYtwmoiYSn9SgWHCsZiChfMYMYZ2nQx',
			name: 'SUI-PERP',
			amm: {
				baseAssetReserve: '234381482764434',
				sqrtK: '109260723000000001',
				lastFundingRate: '-16416',
				lastFundingRateTs: '1705845755',
				lastMarkPriceTwap: '1105972',
				lastMarkPriceTwap5Min: '1101202',
				lastMarkPriceTwapTs: '1705846920',
				lastTradeTs: '1705846920',
				oracle: '3Qub3HaAJaa2xNY7SUqPKd3vVwTqDfDDkEUMPjXD2c1q',
				oracleSource: 'pyth',
				historicalOracleData: {
					lastOraclePrice: '1099778',
					lastOracleDelay: '2',
					lastOracleConf: '0',
					lastOraclePriceTwap: '1106680',
					lastOraclePriceTwap5Min: '1102634',
					lastOraclePriceTwapTs: '1705846920',
				},
				lastOracleReservePriceSpreadPct: '-262785',
				lastOracleConfPct: '1359',
				fundingPeriod: '3600',
				quoteAssetReserve: '50933655038273508156',
				pegMultiplier: '4',
				cumulativeFundingRateLong: '186069301',
				cumulativeFundingRateShort: '186007157',
				last24HAvgFundingRate: '35147',
				lastFundingRateShort: '-16416',
				lastFundingRateLong: '-16416',
				totalLiquidationFee: '4889264000',
				totalFeeMinusDistributions: '-29523583393',
				totalFeeWithdrawn: '5251194706',
				totalFee: '7896066035',
				totalFeeEarnedPerLp: '77063238',
				orderStepSize: '1000000000',
				orderTickSize: '100',
				maxFillReserveFraction: '100',
				maxSlippageRatio: '50',
				baseSpread: '5000',
				curveUpdateIntensity: '100',
				baseAssetAmountWithAmm: '306519581',
				baseAssetAmountLong: '223405000000000',
				baseAssetAmountShort: '-224167000000000',
				quoteAssetAmount: '57945607973',
				terminalQuoteAssetReserve: '50933588428309274920',
				concentrationCoef: '1207100',
				feePool: '[object Object]',
				totalExchangeFee: '10110336057',
				totalMmFee: '-1870961568',
				netRevenueSinceLastFunding: '-141830281',
				lastUpdateSlot: '243204071',
				lastOracleNormalisedPrice: '1098594',
				lastOracleValid: 'true',
				lastBidPriceTwap: '1105864',
				lastAskPriceTwap: '1106081',
				longSpread: '259471',
				shortSpread: '3314',
				maxSpread: '29500',
				ammJitIntensity: '200',
				maxOpenInterest: '2000000000000000',
				maxBaseAssetReserve: '282922257844734',
				minBaseAssetReserve: '194169322578092',
				totalSocialLoss: '0',
				quoteBreakEvenAmountLong: '-237442196125',
				quoteBreakEvenAmountShort: '243508341566',
				quoteEntryAmountLong: '-234074123777',
				quoteEntryAmountShort: '240215285058',
				markStd: '237945',
				oracleStd: '8086',
				longIntensityCount: '0',
				longIntensityVolume: '162204',
				shortIntensityCount: '995',
				shortIntensityVolume: '2797331131',
				volume24H: '91370028405',
				minOrderSize: '1000000000',
				maxPositionSize: '0',
				bidBaseAssetReserve: '234770820775670',
				bidQuoteAssetReserve: '50849187948657797529',
				askBaseAssetReserve: '205083797418879',
				askQuoteAssetReserve: '58209891472312580749',
			},
			numberOfUsersWithBase: '279',
			numberOfUsers: '436',
			marginRatioInitial: '1000',
			marginRatioMaintenance: '500',
			nextFillRecordId: '69433',
			nextFundingRateRecordId: '6221',
			nextCurveRecordId: '1731',
			pnlPool: {
				scaledBalance: '61514197782399',
				marketIndex: '0',
			},
			liquidatorFee: '10000',
			ifLiquidationFee: '20000',
			imfFactor: '450',
			unrealizedPnlImfFactor: '450',
			unrealizedPnlMaxImbalance: '200000000',
			unrealizedPnlInitialAssetWeight: '0',
			unrealizedPnlMaintenanceAssetWeight: '10000',
			insuranceClaim: {
				revenueWithdrawSinceLastSettle: '100000000',
				maxRevenueWithdrawPerPeriod: '100000000',
				lastRevenueWithdrawTs: '1705846454',
				quoteSettledInsurance: '164388488',
				quoteMaxInsurance: '1000000000',
			},
			quoteSpotMarketIndex: '0',
			feeAdjustment: '0',
		};

		const reservePrice = calculatePrice(
			new BN(suiExample.amm.baseAssetReserve),
			new BN(suiExample.amm.quoteAssetReserve),
			new BN(suiExample.amm.pegMultiplier)
		);
		console.log('reservePrice', reservePrice.toString());
		assert(reservePrice.eq(new BN('869243')));

		const reservePriceMod = calculatePrice(
			new BN(suiExample.amm.baseAssetReserve),
			new BN(suiExample.amm.quoteAssetReserve),
			new BN(suiExample.amm.pegMultiplier).add(ONE)
		);
		console.log('reservePriceMod', reservePriceMod.toString());
		assert(reservePriceMod.eq(new BN('1086554')));

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const termsSuiExample: AMMSpreadTerms = calculateSpreadBN(
			Number(suiExample.amm.baseSpread.toString()),
			new BN(suiExample.amm.lastOracleReservePriceSpreadPct),
			new BN(suiExample.amm.lastOracleConfPct),
			Number(suiExample.amm.maxSpread.toString()),
			new BN(suiExample.amm.quoteAssetReserve),
			new BN(suiExample.amm.terminalQuoteAssetReserve),
			new BN(suiExample.amm.pegMultiplier),
			new BN(suiExample.amm.baseAssetAmountWithAmm),
			reservePrice, // reserve price
			new BN(suiExample.amm.totalFeeMinusDistributions),
			new BN(suiExample.amm.netRevenueSinceLastFunding),
			new BN(suiExample.amm.baseAssetReserve),
			new BN(suiExample.amm.minBaseAssetReserve),
			new BN(suiExample.amm.maxBaseAssetReserve),
			new BN(suiExample.amm.markStd),
			new BN(suiExample.amm.oracleStd),
			new BN(suiExample.amm.longIntensityVolume),
			new BN(suiExample.amm.shortIntensityVolume),
			new BN(suiExample.amm.volume24H),
			0,
			ZERO,
			ZERO,
			0,
			true
		);

		assert(termsSuiExample.effectiveLeverageCapped <= 1.000001);
		assert(termsSuiExample.inventorySpreadScale == 1.00007);
		assert(
			termsSuiExample.longSpread == 269813,
			`SUI long spread got ${termsSuiExample.longSpread}`
		);
		assert(
			termsSuiExample.shortSpread == 3925,
			`SUI short spread got ${termsSuiExample.shortSpread}`
		);

		// reset amm reserves/peg to balanced values s.t. liquidity/price is the same
		// to avoid error prone int math

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const termsSuiExampleMod1: AMMSpreadTerms = calculateSpreadBN(
			Number(suiExample.amm.baseSpread.toString()),
			ZERO,
			new BN(suiExample.amm.lastOracleConfPct),
			Number(suiExample.amm.maxSpread.toString()),
			new BN(suiExample.amm.quoteAssetReserve),
			new BN(suiExample.amm.terminalQuoteAssetReserve),
			new BN(suiExample.amm.pegMultiplier),
			new BN(suiExample.amm.baseAssetAmountWithAmm),
			reservePriceMod, // reserve price
			new BN(suiExample.amm.totalFeeMinusDistributions),
			new BN(suiExample.amm.netRevenueSinceLastFunding),
			new BN(suiExample.amm.baseAssetReserve),
			new BN(suiExample.amm.minBaseAssetReserve),
			new BN(suiExample.amm.maxBaseAssetReserve),
			new BN(suiExample.amm.markStd),
			new BN(suiExample.amm.oracleStd),
			new BN(suiExample.amm.longIntensityVolume),
			new BN(suiExample.amm.shortIntensityVolume),
			new BN(suiExample.amm.volume24H),
			0,
			ZERO,
			ZERO,
			0,
			true
		);
		console.log(termsSuiExampleMod1);

		// todo: add sdk recenter function?

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const termsSuiExampleMod2: AMMSpreadTerms = calculateSpreadBN(
			Number(suiExample.amm.baseSpread.toString()),
			ZERO,
			new BN(suiExample.amm.lastOracleConfPct),
			Number(suiExample.amm.maxSpread.toString()),
			new BN(suiExample.amm.sqrtK),
			new BN(suiExample.amm.terminalQuoteAssetReserve),
			reservePriceMod, // peg
			new BN(suiExample.amm.baseAssetAmountWithAmm),
			reservePriceMod, // reserve price
			new BN(suiExample.amm.totalFeeMinusDistributions),
			new BN(suiExample.amm.netRevenueSinceLastFunding),
			new BN(suiExample.amm.sqrtK),
			new BN(suiExample.amm.sqrtK),
			new BN(suiExample.amm.maxBaseAssetReserve),
			new BN(suiExample.amm.markStd),
			new BN(suiExample.amm.oracleStd),
			new BN(suiExample.amm.longIntensityVolume),
			new BN(suiExample.amm.shortIntensityVolume),
			new BN(suiExample.amm.volume24H),
			0,
			ZERO,
			ZERO,
			0,
			true
		);

		console.log(termsSuiExampleMod2);
		assert(
			_.isEqual(
				termsSuiExampleMod2.maxTargetSpread,
				termsSuiExampleMod1.maxTargetSpread
			)
		);
		assert(
			_.isEqual(
				termsSuiExampleMod2.shortSpreadwPS,
				termsSuiExampleMod1.shortSpreadwPS
			)
		);
		assert(
			_.isEqual(
				termsSuiExampleMod2.longSpreadwPS,
				termsSuiExampleMod1.longSpreadwPS
			)
		);

		// note: effectiveLeverage as currently implemented is sensitive to peg change
	});

	it('Spread Reserves (with offset)', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];
		const mockAmm = mockMarket1.amm;
		const mockMarketStats = mockMarket1.marketStats;
		const now = new BN(new Date().getTime() / 1000); //todo

		const oraclePriceData = {
			price: new BN(13.553 * PRICE_PRECISION.toNumber()),
			slot: new BN(68 + 1),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;

		const reserves = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);
		assert(reserves[0].baseAssetReserve.eq(new BN('1000000000')));
		assert(reserves[0].quoteAssetReserve.eq(new BN('12000000000')));
		assert(reserves[1].baseAssetReserve.eq(new BN('1000000000')));
		assert(reserves[1].quoteAssetReserve.eq(new BN('12000000000')));

		mockAmm.baseAssetReserve = new BN(1000000000);
		mockAmm.quoteAssetReserve = new BN(1000000000);
		mockAmm.sqrtK = new BN(1000000000);

		mockAmm.baseAssetAmountWithAmm = new BN(0);
		mockAmm.pegMultiplier = new BN(13.553 * PEG_PRECISION.toNumber());
		mockAmm.ammJitIntensity = 200;
		mockAmm.curveUpdateIntensity = 200;
		mockAmm.baseSpread = 2500;
		mockAmm.maxSpread = 25000;

		mockMarketStats.last24HAvgFundingRate = new BN(7590328523);

		mockMarketStats.lastMarkPriceTwap = new BN(
			(oraclePriceData.price.toNumber() / 1e6 - 0.01) * 1e6
		);
		mockMarketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			(oraclePriceData.price.toNumber() / 1e6 + 0.015) * 1e6
		);

		mockMarketStats.historicalOracleData.lastOraclePriceTwap5Min = new BN(
			(oraclePriceData.price.toNumber() / 1e6 + 0.005) * 1e6
		);
		mockMarketStats.lastMarkPriceTwap5Min = new BN(
			(oraclePriceData.price.toNumber() / 1e6 - 0.005) * 1e6
		);

		console.log('starting rr:');
		let reservePrice: BN | undefined = undefined;
		if (!reservePrice) {
			reservePrice = calculatePrice(
				mockAmm.baseAssetReserve,
				mockAmm.quoteAssetReserve,
				mockAmm.pegMultiplier
			);
		}

		const targetPrice = oraclePriceData?.price || reservePrice;
		const confInterval = oraclePriceData.confidence || ZERO;
		const targetMarkSpreadPct = reservePrice
			.sub(targetPrice)
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(reservePrice);

		const confIntervalPct = confInterval
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(reservePrice);

		// now = now || new BN(new Date().getTime() / 1000); //todo
		const liveOracleStd = calculateLiveOracleStd(
			mockMarketStats,
			oraclePriceData,
			now
		);
		console.log('reservePrice:', reservePrice.toString());
		console.log('targetMarkSpreadPct:', targetMarkSpreadPct.toString());
		console.log('confIntervalPct:', confIntervalPct.toString());
		console.log('liveOracleStd:', liveOracleStd.toString());

		const tt = calculateSpread(mockAmm, mockMarketStats, oraclePriceData, now);
		console.log(tt);

		console.log('amm.baseAssetReserve:', mockAmm.baseAssetReserve.toString());
		assert(mockAmm.baseAssetReserve.eq(new BN('1000000000')));
		const reserves2 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);
		console.log(reserves2[0].baseAssetReserve.toString());
		console.log(reserves2[0].quoteAssetReserve.toString());

		assert(reserves2[0].baseAssetReserve.eq(new BN('1006289308')));
		assert(reserves2[0].quoteAssetReserve.eq(new BN('993750000')));
		assert(reserves2[1].baseAssetReserve.eq(new BN('993788819')));
		assert(reserves2[1].quoteAssetReserve.eq(new BN('1006250000')));

		// create imbalance for reference price offset
		mockAmm.baseAssetReserve = new BN(1000000000 * 1.1);
		mockAmm.quoteAssetReserve = new BN(1000000000 / 1.1);
		mockAmm.sqrtK = squareRootBN(
			mockAmm.baseAssetReserve.mul(mockAmm.quoteAssetReserve)
		);

		mockAmm.baseAssetAmountWithAmm = new BN(1000000000 * 0.1);

		const maxOffset = Math.max(
			mockAmm.maxSpread / 5,
			(PERCENTAGE_PRECISION.toNumber() / 10000) *
				(mockAmm.curveUpdateIntensity - 100)
		);
		const liquidityFraction = calculateInventoryLiquidityRatio(
			mockAmm.baseAssetAmountWithAmm,
			mockAmm.baseAssetReserve,
			mockAmm.minBaseAssetReserve,
			mockAmm.maxBaseAssetReserve
		);
		console.log('liquidityFraction:', liquidityFraction.toString());
		assert(liquidityFraction.eq(new BN(1000000))); // full
		const liquidityFractionSigned = liquidityFraction.mul(
			sigNum(mockAmm.baseAssetAmountWithAmm)
		);
		const referencePriceOffset = calculateReferencePriceOffset(
			reservePrice,
			mockMarketStats.last24HAvgFundingRate,
			liquidityFractionSigned,
			mockMarketStats.historicalOracleData.lastOraclePriceTwap5Min,
			mockMarketStats.lastMarkPriceTwap5Min,
			mockMarketStats.historicalOracleData.lastOraclePriceTwap,
			mockMarketStats.lastMarkPriceTwap,
			maxOffset
		);
		console.log('referencePriceOffset:', referencePriceOffset.toString());
		assert(referencePriceOffset.eq(new BN(10000)));
		assert(referencePriceOffset.eq(new BN(maxOffset)));

		// mockAmm.curveUpdateIntensity = 100;
		const reserves3 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);
		console.log(reserves3[0].baseAssetReserve.toString());
		console.log(reserves3[0].quoteAssetReserve.toString());

		assert(reserves3[0].baseAssetReserve.eq(new BN('1100068201')));
		assert(reserves3[0].quoteAssetReserve.eq(new BN('909034546')));
		assert(reserves3[1].baseAssetReserve.eq(new BN('989999998')));
		assert(reserves3[1].quoteAssetReserve.eq(new BN('1010101010')));

		const p1 = calculatePrice(
			reserves3[0].baseAssetReserve,
			reserves3[0].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const p2 = calculatePrice(
			reserves3[1].baseAssetReserve,
			reserves3[1].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		assert(p1.eq(new BN(11199437)));
		assert(p2.eq(new BN(13828180)));

		mockAmm.curveUpdateIntensity = 110;
		const reserves4 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);

		assert(reserves4[0].baseAssetReserve.eq(new BN('1100068201')));
		assert(reserves4[0].quoteAssetReserve.eq(new BN('909034546')));
		assert(reserves4[1].baseAssetReserve.eq(new BN('989999998')));
		assert(reserves4[1].quoteAssetReserve.eq(new BN('1010101010')));

		const p1RF = calculatePrice(
			reserves4[0].baseAssetReserve,
			reserves4[0].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const p2RF = calculatePrice(
			reserves4[1].baseAssetReserve,
			reserves4[1].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		assert(p1RF.eq(new BN(11199437)));
		assert(p2RF.eq(new BN(13828180)));
		// no ref price offset at 100
		mockAmm.curveUpdateIntensity = 100;
		const reserves5 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);

		assert(reserves5[0].baseAssetReserve.eq(new BN('1100068201')));
		assert(reserves5[0].quoteAssetReserve.eq(new BN('909034546')));
		assert(reserves5[1].baseAssetReserve.eq(new BN('989999998')));
		assert(reserves5[1].quoteAssetReserve.eq(new BN('1010101010')));

		const p1RFNone = calculatePrice(
			reserves5[0].baseAssetReserve,
			reserves5[0].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const p2RFNone = calculatePrice(
			reserves5[1].baseAssetReserve,
			reserves5[1].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		assert(p1RFNone.eq(new BN(11199437)));
		assert(p2RFNone.eq(new BN(13828180)));
		assert(p1RF.sub(p1RFNone).eq(new BN(0)));
		assert(p2RF.sub(p2RFNone).eq(new BN(0))); // todo?
	});
	it('Spread Reserves (with negative offset)', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];
		const mockAmm = mockMarket1.amm;
		const mockMarketStats = mockMarket1.marketStats;
		const now = new BN(new Date().getTime() / 1000); //todo

		const oraclePriceData = {
			price: new BN(13.553 * PRICE_PRECISION.toNumber()),
			slot: new BN(68 + 1),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;

		const reserves = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);
		assert(reserves[0].baseAssetReserve.eq(new BN('1000000000')));
		assert(reserves[0].quoteAssetReserve.eq(new BN('12000000000')));
		assert(reserves[1].baseAssetReserve.eq(new BN('1000000000')));
		assert(reserves[1].quoteAssetReserve.eq(new BN('12000000000')));

		mockAmm.baseAssetReserve = new BN(1000000000);
		mockAmm.quoteAssetReserve = new BN(1000000000);
		mockAmm.sqrtK = new BN(1000000000);

		mockAmm.baseAssetAmountWithAmm = new BN(0);
		mockAmm.pegMultiplier = new BN(13.553 * PEG_PRECISION.toNumber());
		mockAmm.ammJitIntensity = 200;
		mockAmm.curveUpdateIntensity = 200;
		mockAmm.baseSpread = 2500;
		mockAmm.maxSpread = 25000;

		mockMarketStats.last24HAvgFundingRate = new BN(-7590328523);

		mockMarketStats.lastMarkPriceTwap = new BN(
			(oraclePriceData.price.toNumber() / 1e6 + 0.01) * 1e6
		);
		mockMarketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			(oraclePriceData.price.toNumber() / 1e6 - 0.015) * 1e6
		);

		mockMarketStats.historicalOracleData.lastOraclePriceTwap5Min = new BN(
			(oraclePriceData.price.toNumber() / 1e6 + 0.005) * 1e6
		);
		mockMarketStats.lastMarkPriceTwap5Min = new BN(
			(oraclePriceData.price.toNumber() / 1e6 - 0.005) * 1e6
		);

		console.log('starting rr:');
		let reservePrice = undefined;
		if (!reservePrice) {
			reservePrice = calculatePrice(
				mockAmm.baseAssetReserve,
				mockAmm.quoteAssetReserve,
				mockAmm.pegMultiplier
			);
		}

		const targetPrice = oraclePriceData?.price || reservePrice;
		const confInterval = oraclePriceData.confidence || ZERO;
		const targetMarkSpreadPct = reservePrice
			.sub(targetPrice)
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(reservePrice);

		const confIntervalPct = confInterval
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(reservePrice);

		// now = now || new BN(new Date().getTime() / 1000); //todo
		const liveOracleStd = calculateLiveOracleStd(
			mockMarketStats,
			oraclePriceData,
			now
		);
		console.log('reservePrice:', reservePrice.toString());
		console.log('targetMarkSpreadPct:', targetMarkSpreadPct.toString());
		console.log('confIntervalPct:', confIntervalPct.toString());

		console.log('liveOracleStd:', liveOracleStd.toString());

		const tt = calculateSpread(mockAmm, mockMarketStats, oraclePriceData, now);
		console.log(tt);

		console.log('amm.baseAssetReserve:', mockAmm.baseAssetReserve.toString());
		assert(mockAmm.baseAssetReserve.eq(new BN('1000000000')));
		const reserves2 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);
		console.log(reserves2[1].baseAssetReserve.toString());
		console.log(reserves2[1].quoteAssetReserve.toString());

		assert(reserves2[0].baseAssetReserve.eq(new BN('1006289308')));
		assert(reserves2[0].quoteAssetReserve.eq(new BN('993750000')));
		assert(reserves2[1].baseAssetReserve.eq(new BN('993788819')));
		assert(reserves2[1].quoteAssetReserve.eq(new BN('1006250000')));

		// create imbalance for reference price offset
		mockAmm.baseAssetReserve = new BN(1000000000 / 1.1);
		mockAmm.quoteAssetReserve = new BN(1000000000 * 1.1);
		mockAmm.sqrtK = squareRootBN(
			mockAmm.baseAssetReserve.mul(mockAmm.quoteAssetReserve)
		);

		mockAmm.baseAssetAmountWithAmm = new BN(-1000000000 * 0.1);

		const maxOffset = Math.max(
			mockAmm.maxSpread / 5,
			(PERCENTAGE_PRECISION.toNumber() / 10000) *
				(mockAmm.curveUpdateIntensity - 100)
		);
		const liquidityFraction = calculateInventoryLiquidityRatio(
			mockAmm.baseAssetAmountWithAmm,
			mockAmm.baseAssetReserve,
			mockAmm.minBaseAssetReserve,
			mockAmm.maxBaseAssetReserve
		);
		console.log('liquidityFraction:', liquidityFraction.toString());
		assert(liquidityFraction.eq(new BN(1000000))); // full
		const liquidityFractionSigned = liquidityFraction.mul(
			sigNum(mockAmm.baseAssetAmountWithAmm)
		);
		const referencePriceOffset = calculateReferencePriceOffset(
			reservePrice,
			mockMarketStats.last24HAvgFundingRate,
			liquidityFractionSigned,
			mockMarketStats.historicalOracleData.lastOraclePriceTwap5Min,
			mockMarketStats.lastMarkPriceTwap5Min,
			mockMarketStats.historicalOracleData.lastOraclePriceTwap,
			mockMarketStats.lastMarkPriceTwap,
			maxOffset
		);
		console.log('referencePriceOffset:', referencePriceOffset.toString());
		assert(referencePriceOffset.eq(new BN(-10000))); // neg

		// assert(referencePriceOffset.eq(new BN(maxOffset)));

		// mockAmm.curveUpdateIntensity = 100;
		const reserves3 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);
		console.log(reserves3[0].baseAssetReserve.toString());
		console.log(reserves3[0].quoteAssetReserve.toString());

		assert(reserves3[0].baseAssetReserve.eq(new BN('999999998')));
		assert(reserves3[0].quoteAssetReserve.eq(new BN('1000000000')));
		assert(reserves3[1].baseAssetReserve.eq(new BN('909034547')));
		assert(reserves3[1].quoteAssetReserve.eq(new BN('1100068200')));

		const p1 = calculatePrice(
			reserves3[0].baseAssetReserve,
			reserves3[0].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const p2 = calculatePrice(
			reserves3[1].baseAssetReserve,
			reserves3[1].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		assert(p1.eq(new BN(13553000)));
		assert(p2.eq(new BN(16401163)));

		mockAmm.curveUpdateIntensity = 110;
		const reserves4 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);

		assert(reserves4[0].baseAssetReserve.eq(new BN('999999998')));
		assert(reserves4[0].quoteAssetReserve.eq(new BN('1000000000')));
		assert(reserves4[1].baseAssetReserve.eq(new BN('909034547')));
		assert(reserves4[1].quoteAssetReserve.eq(new BN('1100068200')));

		const p1RF = calculatePrice(
			reserves4[0].baseAssetReserve,
			reserves4[0].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const p2RF = calculatePrice(
			reserves4[1].baseAssetReserve,
			reserves4[1].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		assert(p1RF.eq(new BN(13553000)));
		assert(p2RF.eq(new BN(16401163)));

		// no ref price offset at 100
		mockAmm.curveUpdateIntensity = 100;
		const reserves5 = calculateSpreadReserves(
			mockAmm,
			mockMarketStats,
			oraclePriceData,
			now
		);

		assert(reserves5[0].baseAssetReserve.eq(new BN('999999998')));
		assert(reserves5[0].quoteAssetReserve.eq(new BN('1000000000')));
		assert(reserves5[1].baseAssetReserve.eq(new BN('909034547')));
		assert(reserves5[1].quoteAssetReserve.eq(new BN('1100068200')));

		const p1RFNone = calculatePrice(
			reserves5[0].baseAssetReserve,
			reserves5[0].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const p2RFNone = calculatePrice(
			reserves5[1].baseAssetReserve,
			reserves5[1].quoteAssetReserve,
			mockAmm.pegMultiplier
		);

		const rr = p2RF.sub(p2RFNone).mul(PERCENTAGE_PRECISION).div(p2RF);
		assert(p1RFNone.eq(new BN(13553000)));
		assert(p2RFNone.eq(new BN(16401163)));
		assert(p1RF.sub(p1RFNone).eq(new BN(0))); // todo?
		assert(rr.eq(new BN(0)));
	});

	it('live update functions', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];
		const mockMarketStats = mockMarket1.marketStats;
		const now = new BN(new Date().getTime() / 1000); //todo
		const slot = 999999999;

		const oraclePriceData = {
			price: new BN(13.553 * PRICE_PRECISION.toNumber()),
			slot: new BN(slot),
			confidence: new BN(1000),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarketStats.oracleStd = new BN(0.18 * PRICE_PRECISION.toNumber());
		mockMarketStats.fundingPeriod = new BN(3600);
		mockMarketStats.historicalOracleData.lastOraclePriceTwap =
			oraclePriceData.price.mul(new BN(999)).div(new BN(1000));
		mockMarketStats.historicalOracleData.lastOraclePriceTwapTs = now.sub(
			new BN(11)
		);

		const liveOracleTwap = calculateLiveOracleTwap(
			mockMarketStats.historicalOracleData,
			oraclePriceData,
			now,
			mockMarketStats.fundingPeriod
		);
		console.log('liveOracleTwap:', liveOracleTwap.toNumber());
		assert(liveOracleTwap.eq(new BN(13539488)));

		const liveOracleStd = calculateLiveOracleStd(
			mockMarketStats,
			oraclePriceData,
			now
		);
		assert(liveOracleStd.eq(new BN(13732450)));

		mockMarketStats.lastOracleConfPct = new BN(150000);
		const reservePrice = new BN(13.553 * PRICE_PRECISION.toNumber());
		const newConfPct = getNewOracleConfPct(
			mockMarketStats,
			oraclePriceData,
			reservePrice,
			now
		);
		console.log('newConfPct:', newConfPct.toString());

		assert(
			now
				.sub(mockMarketStats.historicalOracleData.lastOraclePriceTwapTs)
				.gt(ZERO)
		);

		assert(newConfPct.eq(new BN(135000)));

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION.divn(10),
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION.divn(10),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(10),
				slotsBeforeStaleForMargin: new BN(60),
				confidenceIntervalMaxSize: new BN(20000),
				tooVolatileRatio: new BN(5),
			},
		};

		// good oracle
		assert(
			isOracleValid(mockMarket1, oraclePriceData, oracleGuardRails, slot + 5)
		);

		// conf too high
		assert(
			!isOracleValid(
				mockMarket1,
				{
					price: new BN(13.553 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot),
					confidence: new BN(13.553 * PRICE_PRECISION.toNumber() * 0.021),
					hasSufficientNumberOfDataPoints: true,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot
			)
		);

		// not hasSufficientNumberOfDataPoints
		assert(
			!isOracleValid(
				mockMarket1,
				{
					price: new BN(13.553 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot),
					confidence: new BN(1),
					hasSufficientNumberOfDataPoints: false,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot
			)
		);

		// negative oracle price
		assert(
			!isOracleValid(
				mockMarket1,
				{
					price: new BN(-1 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot),
					confidence: new BN(1),
					hasSufficientNumberOfDataPoints: true,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot
			)
		);

		// too delayed for amm
		assert(
			!isOracleValid(
				mockMarket1,
				{
					price: new BN(13.553 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot),
					confidence: new BN(1),
					hasSufficientNumberOfDataPoints: true,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot + 100
			)
		);

		// im passing stale slot (should not call oracle invalid)
		assert(
			isOracleValid(
				mockMarket1,
				{
					price: new BN(13.553 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot + 100),
					confidence: new BN(1),
					hasSufficientNumberOfDataPoints: true,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot
			)
		);

		// too volatile (more than 5x higher)
		assert(
			!isOracleValid(
				mockMarket1,
				{
					price: new BN(113.553 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot + 5),
					confidence: new BN(1),
					hasSufficientNumberOfDataPoints: true,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot
			)
		);

		// too volatile (more than 1/5 lower)
		assert(
			!isOracleValid(
				mockMarket1,
				{
					price: new BN(0.553 * PRICE_PRECISION.toNumber()),
					slot: new BN(slot + 5),
					confidence: new BN(1),
					hasSufficientNumberOfDataPoints: true,
					isMMOracleActive: true,
				} as MMOraclePriceData,
				oracleGuardRails,
				slot
			)
		);
	});

	it('predicted funding rate mock1', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];

		// make it like RNDR
		const now = new BN(1688878353);

		mockMarket1.marketStats.fundingPeriod = new BN(3600);
		mockMarket1.lastFundingRateTs = new BN(1688860817);

		const currentMarkPrice = new BN(1.9843 * PRICE_PRECISION.toNumber()); // trading at a premium
		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(1.9535 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		};
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			1.9535 * PRICE_PRECISION.toNumber()
		);

		// mockMarket1.amm.pegMultiplier = new BN(1.897573 * 1e3);

		mockMarket1.marketStats.lastMarkPriceTwap = new BN(
			1.945594 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastBidPriceTwap = new BN(
			1.941629 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastAskPriceTwap = new BN(
			1.94956 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastMarkPriceTwapTs = new BN(1688877729);

		mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			1.942449 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwapTs = new BN(
			1688878333
		);

		const [
			_markTwapLive,
			_oracleTwapLive,
			_lowerboundEst,
			_cappedAltEst,
			_interpEst,
		] = calculateAllEstimatedFundingRate(
			mockMarket1,
			mmOraclePriceData,
			mmOraclePriceData as unknown as OraclePriceData,
			currentMarkPrice,
			now
		);

		const [markTwapLive, oracleTwapLive, est1, est2] =
			calculateLongShortFundingRateAndLiveTwaps(
				mockMarket1,
				mmOraclePriceData,
				mmOraclePriceData as unknown as OraclePriceData,
				currentMarkPrice,
				now
			);

		// console.log(markTwapLive.toString());
		// console.log(oracleTwapLive.toString());
		// console.log(est1.toString());
		// console.log(est2.toString());

		assert(markTwapLive.eq(new BN('1949826')));
		assert(oracleTwapLive.eq(new BN('1942510')));
		assert(est1.eq(new BN('14858')));
		assert(est2.eq(new BN('14858')));
	});

	it('predicted funding rate mock2', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];

		// make it like OP
		const now = new BN(1688881915);

		mockMarket1.marketStats.fundingPeriod = new BN(3600);
		mockMarket1.lastFundingRateTs = new BN(1688864415);

		const currentMarkPrice = new BN(1.2242 * PRICE_PRECISION.toNumber()); // trading at a premium
		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(1.224 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		};
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			1.9535 * PRICE_PRECISION.toNumber()
		);

		// mockMarket1.amm.pegMultiplier = new BN(1.897573 * 1e3);

		mockMarket1.marketStats.lastMarkPriceTwap = new BN(
			1.218363 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastBidPriceTwap = new BN(
			1.218363 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastAskPriceTwap = new BN(
			1.218364 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastMarkPriceTwapTs = new BN(1688878815);

		mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			1.220964 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwapTs = new BN(
			1688879991
		);

		const [
			_markTwapLive,
			_oracleTwapLive,
			_lowerboundEst,
			_cappedAltEst,
			_interpEst,
		] = calculateAllEstimatedFundingRate(
			mockMarket1,
			mmOraclePriceData,
			mmOraclePriceData as unknown as OraclePriceData,
			currentMarkPrice,
			now
		);

		// console.log(_markTwapLive.toString());
		// console.log(_oracleTwapLive.toString());
		// console.log(_lowerboundEst.toString());
		// console.log(_cappedAltEst.toString());
		// console.log(_interpEst.toString());
		// console.log('-----');

		const [markTwapLive, oracleTwapLive, est1, est2] =
			calculateLongShortFundingRateAndLiveTwaps(
				mockMarket1,
				mmOraclePriceData,
				mmOraclePriceData as unknown as OraclePriceData,
				currentMarkPrice,
				now
			);

		console.log(
			'markTwapLive:',
			mockMarket1.marketStats.lastMarkPriceTwap.toString(),
			'->',
			markTwapLive.toString()
		);
		console.log(
			'oracTwapLive:',
			mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap.toString(),
			'->',
			oracleTwapLive.toString()
		);
		console.log('pred funding:', est1.toString(), est2.toString());

		assert(markTwapLive.eq(new BN('1222131')));
		assert(oracleTwapLive.eq(new BN('1222586')));
		assert(est1.eq(est2));
		assert(est2.eq(new BN('1247')));
	});

	it('predicted funding rate mock clamp', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];

		// make it like OP
		const now = new BN(1688881915);

		mockMarket1.marketStats.fundingPeriod = new BN(3600);
		mockMarket1.lastFundingRateTs = new BN(1688864415);

		const currentMarkPrice = new BN(1.2242 * PRICE_PRECISION.toNumber()); // trading at a premium
		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(1.924 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			1.9535 * PRICE_PRECISION.toNumber()
		);

		// mockMarket1.amm.pegMultiplier = new BN(1.897573 * 1e3);

		mockMarket1.marketStats.lastMarkPriceTwap = new BN(
			1.218363 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastBidPriceTwap = new BN(
			1.218363 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastAskPriceTwap = new BN(
			1.218364 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.lastMarkPriceTwapTs = new BN(1688878815);

		mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap = new BN(
			1.820964 * PRICE_PRECISION.toNumber()
		);
		mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwapTs = new BN(
			1688879991
		);
		mockMarket1.contractTier = ContractTier.A;

		const [
			_markTwapLive,
			_oracleTwapLive,
			_lowerboundEst,
			_cappedAltEst,
			_interpEst,
		] = calculateAllEstimatedFundingRate(
			mockMarket1,
			mmOraclePriceData,
			mmOraclePriceData as unknown as OraclePriceData,
			currentMarkPrice,
			now
		);

		// console.log(_markTwapLive.toString());
		// console.log(_oracleTwapLive.toString());
		// console.log(_lowerboundEst.toString());
		// console.log(_cappedAltEst.toString());
		// console.log(_interpEst.toString());
		// console.log('-----');

		let [markTwapLive, oracleTwapLive, est1, est2] =
			calculateLongShortFundingRateAndLiveTwaps(
				mockMarket1,
				mmOraclePriceData,
				mmOraclePriceData as unknown as OraclePriceData,
				currentMarkPrice,
				now
			);

		console.log(
			'markTwapLive:',
			mockMarket1.marketStats.lastMarkPriceTwap.toString(),
			'->',
			markTwapLive.toString()
		);
		console.log(
			'oracTwapLive:',
			mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap.toString(),
			'->',
			oracleTwapLive.toString()
		);
		console.log('pred funding:', est1.toString(), est2.toString());

		assert(markTwapLive.eq(new BN('1680634')));
		assert(oracleTwapLive.eq(new BN('1876031')));
		assert(est1.eq(est2));
		assert(est2.eq(new BN('-126261')));

		mockMarket1.contractTier = ContractTier.C;

		[markTwapLive, oracleTwapLive, est1, est2] =
			calculateLongShortFundingRateAndLiveTwaps(
				mockMarket1,
				mmOraclePriceData,
				mmOraclePriceData as unknown as OraclePriceData,
				currentMarkPrice,
				now
			);

		console.log(
			'markTwapLive:',
			mockMarket1.marketStats.lastMarkPriceTwap.toString(),
			'->',
			markTwapLive.toString()
		);
		console.log(
			'oracTwapLive:',
			mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap.toString(),
			'->',
			oracleTwapLive.toString()
		);
		console.log('pred funding:', est1.toString(), est2.toString());

		assert(markTwapLive.eq(new BN('1680634')));
		assert(oracleTwapLive.eq(new BN('1876031')));
		assert(est1.eq(est2));
		assert(est2.eq(new BN('-208332')));

		mockMarket1.contractTier = ContractTier.SPECULATIVE;

		[markTwapLive, oracleTwapLive, est1, est2] =
			calculateLongShortFundingRateAndLiveTwaps(
				mockMarket1,
				mmOraclePriceData,
				mmOraclePriceData as unknown as OraclePriceData,
				currentMarkPrice,
				now
			);

		console.log(
			'markTwapLive:',
			mockMarket1.marketStats.lastMarkPriceTwap.toString(),
			'->',
			markTwapLive.toString()
		);
		console.log(
			'oracTwapLive:',
			mockMarket1.marketStats.historicalOracleData.lastOraclePriceTwap.toString(),
			'->',
			oracleTwapLive.toString()
		);
		console.log('pred funding:', est1.toString(), est2.toString());

		assert(markTwapLive.eq(new BN('1680634')));
		assert(oracleTwapLive.eq(new BN('1876031')));
		assert(est1.eq(est2));
		assert(est2.eq(new BN('-416666')));
	});

	it('orderbook L2 gen (no topOfBookQuoteAmounts, 10 numOrders, low liquidity)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];
		const cc = 38104569;
		mockMarket1.amm.baseAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.maxBaseAssetReserve = mockMarket1.amm.baseAssetReserve.add(
			new BN(1234835)
		);
		mockMarket1.amm.minBaseAssetReserve =
			mockMarket1.amm.baseAssetReserve.sub(BASE_PRECISION);
		mockMarket1.amm.quoteAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.pegMultiplier = new BN(18.32 * PEG_PRECISION.toNumber());
		mockMarket1.amm.sqrtK = new BN(cc).mul(BASE_PRECISION);

		const now = new BN(1688881915);

		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(18.624 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			18.5535 * PRICE_PRECISION.toNumber()
		);

		const updatedAmm = calculateUpdatedAMM(mockMarket1.amm, mmOraclePriceData);

		const [openBids, openAsks] = calculateMarketOpenBidAsk(
			updatedAmm.baseAssetReserve,
			updatedAmm.minBaseAssetReserve,
			updatedAmm.maxBaseAssetReserve,
			mockMarket1.orderStepSize
		);

		const generator = getVammL2Generator({
			marketAccount: mockMarket1,
			mmOraclePriceData,
			numOrders: 10,
			now,
			topOfBookQuoteAmounts: [],
		});

		const bids = Array.from(generator.getL2Bids());
		// console.log(bids);

		const totalBidSize = bids.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);

		console.log(
			'totalBidSize:',
			totalBidSize.toString(),
			'openBids:',
			openBids.toString()
		);
		assert(totalBidSize.sub(openBids).abs().lt(new BN(10))); // smol err
		assert(totalBidSize.sub(openBids).lt(ZERO)); // under estimation

		const asks = Array.from(generator.getL2Asks());
		// console.log(asks);

		const totalAskSize = asks.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);
		console.log(
			'totalAskSize:',
			totalAskSize.toString(),
			'openAsks:',
			openAsks.toString()
		);
		assert(totalAskSize.sub(openAsks.abs()).lte(new BN(5))); // only tiny rounding errors
	});

	it('orderbook L2 gen (no topOfBookQuoteAmounts, 10 numOrders)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];
		const cc = 38104569;
		mockMarket1.amm.baseAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.maxBaseAssetReserve = mockMarket1.amm.baseAssetReserve.mul(
			new BN(2)
		);
		mockMarket1.amm.minBaseAssetReserve = mockMarket1.amm.baseAssetReserve.div(
			new BN(2)
		);
		mockMarket1.amm.quoteAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.pegMultiplier = new BN(18.32 * PEG_PRECISION.toNumber());
		mockMarket1.amm.sqrtK = new BN(cc).mul(BASE_PRECISION);

		const now = new BN(1688881915);

		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(18.624 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			18.5535 * PRICE_PRECISION.toNumber()
		);

		const updatedAmm = calculateUpdatedAMM(mockMarket1.amm, mmOraclePriceData);

		const [openBids, openAsks] = calculateMarketOpenBidAsk(
			updatedAmm.baseAssetReserve,
			updatedAmm.minBaseAssetReserve,
			updatedAmm.maxBaseAssetReserve,
			mockMarket1.orderStepSize
		);

		const generator = getVammL2Generator({
			marketAccount: mockMarket1,
			mmOraclePriceData,
			numOrders: 10,
			now,
			topOfBookQuoteAmounts: [],
		});

		const bids = Array.from(generator.getL2Bids());
		// console.log(bids);

		const totalBidSize = bids.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);

		console.log(
			'totalBidSize:',
			totalBidSize.toString(),
			'openBids:',
			openBids.toString()
		);
		assert(totalBidSize.eq(openBids));

		const asks = Array.from(generator.getL2Asks());
		// console.log(asks);

		const totalAskSize = asks.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);
		console.log(
			'totalAskSize:',
			totalAskSize.toString(),
			'openAsks:',
			openAsks.toString()
		);
		assert(totalAskSize.sub(openAsks.abs()).lte(new BN(5))); // only tiny rounding errors
	});

	it('orderbook L2 gen (4 topOfBookQuoteAmounts, 10 numOrders)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];
		const cc = 38104569;
		mockMarket1.amm.baseAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.maxBaseAssetReserve = mockMarket1.amm.baseAssetReserve.mul(
			new BN(2)
		);
		mockMarket1.amm.minBaseAssetReserve = mockMarket1.amm.baseAssetReserve.div(
			new BN(2)
		);
		mockMarket1.amm.quoteAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.pegMultiplier = new BN(18.32 * PEG_PRECISION.toNumber());
		mockMarket1.amm.sqrtK = new BN(cc).mul(BASE_PRECISION);

		const now = new BN(1688881915);

		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(18.624 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			18.5535 * PRICE_PRECISION.toNumber()
		);

		const updatedAmm = calculateUpdatedAMM(mockMarket1.amm, mmOraclePriceData);

		const [openBids, openAsks] = calculateMarketOpenBidAsk(
			updatedAmm.baseAssetReserve,
			updatedAmm.minBaseAssetReserve,
			updatedAmm.maxBaseAssetReserve,
			mockMarket1.orderStepSize
		);

		assert(!openAsks.eq(openBids));

		const generator = getVammL2Generator({
			marketAccount: mockMarket1,
			mmOraclePriceData,
			numOrders: 10,
			now,
			topOfBookQuoteAmounts: [
				new BN(10).mul(QUOTE_PRECISION),
				new BN(100).mul(QUOTE_PRECISION),
				new BN(1000).mul(QUOTE_PRECISION),
				new BN(10000).mul(QUOTE_PRECISION),
			],
		});

		const bids = Array.from(generator.getL2Bids());
		// console.log(bids);

		const totalBidSize = bids.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);

		console.log(
			'totalBidSize:',
			totalBidSize.toString(),
			'openBids:',
			openBids.toString()
		);
		assert(totalBidSize.eq(openBids));

		const asks = Array.from(generator.getL2Asks());
		// console.log(asks);

		const totalAskSize = asks.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);
		console.log(
			'totalAskSize:',
			totalAskSize.toString(),
			'openAsks:',
			openAsks.toString()
		);
		assert(totalAskSize.sub(openAsks.abs()).lte(new BN(5))); // only tiny rounding errors
	});

	it('orderbook L2 gen (4 topOfBookQuoteAmounts, 10 numOrders, low bid liquidity)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];
		const cc = 38104569;
		mockMarket1.amm.baseAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.maxBaseAssetReserve =
			mockMarket1.amm.baseAssetReserve.add(BASE_PRECISION); // only 1 base
		mockMarket1.amm.minBaseAssetReserve = mockMarket1.amm.baseAssetReserve.div(
			new BN(2)
		);
		mockMarket1.amm.quoteAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.pegMultiplier = new BN(18.32 * PEG_PRECISION.toNumber());
		mockMarket1.amm.sqrtK = new BN(cc).mul(BASE_PRECISION);

		const now = new BN(1688881915);

		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(18.624 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			18.5535 * PRICE_PRECISION.toNumber()
		);

		const updatedAmm = calculateUpdatedAMM(mockMarket1.amm, mmOraclePriceData);

		const [openBids, openAsks] = calculateMarketOpenBidAsk(
			updatedAmm.baseAssetReserve,
			updatedAmm.minBaseAssetReserve,
			updatedAmm.maxBaseAssetReserve,
			mockMarket1.orderStepSize
		);

		assert(!openAsks.eq(openBids));

		const generator = getVammL2Generator({
			marketAccount: mockMarket1,
			mmOraclePriceData,
			numOrders: 10,
			now,
			topOfBookQuoteAmounts: [
				new BN(10).mul(QUOTE_PRECISION),
				new BN(100).mul(QUOTE_PRECISION),
				new BN(1000).mul(QUOTE_PRECISION),
				new BN(10000).mul(QUOTE_PRECISION),
			],
		});

		const bids = Array.from(generator.getL2Bids());
		assert(bids.length == 2);
		console.log(bids[0].size.toString());
		console.log(bids[1].size.toString());

		const totalBidSize = bids.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);

		console.log(
			'totalBidSize:',
			totalBidSize.toString(),
			'openBids:',
			openBids.toString()
		);
		assert(totalBidSize.eq(openBids));

		const asks = Array.from(generator.getL2Asks());
		// console.log(asks);

		const totalAskSize = asks.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);
		console.log(
			'totalAskSize:',
			totalAskSize.toString(),
			'openAsks:',
			openAsks.toString()
		);
		assert(totalAskSize.sub(openAsks.abs()).lte(new BN(5))); // only tiny rounding errors
	});

	it('orderbook L2 gen (4 topOfBookQuoteAmounts, 10 numOrders, low ask liquidity)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];
		const cc = 38104569;
		mockMarket1.amm.baseAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.maxBaseAssetReserve = mockMarket1.amm.baseAssetReserve.add(
			BASE_PRECISION.mul(new BN(1000))
		); // 1000 base
		mockMarket1.amm.minBaseAssetReserve = mockMarket1.amm.baseAssetReserve.sub(
			BASE_PRECISION.div(new BN(2))
		); // only .5 base
		mockMarket1.amm.quoteAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.pegMultiplier = new BN(18.32 * PEG_PRECISION.toNumber());
		mockMarket1.amm.sqrtK = new BN(cc).mul(BASE_PRECISION);

		const now = new BN(1688881915);

		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(18.624 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		};
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			18.5535 * PRICE_PRECISION.toNumber()
		);

		const updatedAmm = calculateUpdatedAMM(mockMarket1.amm, mmOraclePriceData);

		const [openBids, openAsks] = calculateMarketOpenBidAsk(
			updatedAmm.baseAssetReserve,
			updatedAmm.minBaseAssetReserve,
			updatedAmm.maxBaseAssetReserve,
			mockMarket1.orderStepSize
		);

		assert(!openAsks.eq(openBids));

		const generator = getVammL2Generator({
			marketAccount: mockMarket1,
			mmOraclePriceData,
			numOrders: 10,
			now,
			topOfBookQuoteAmounts: [
				new BN(10).mul(QUOTE_PRECISION),
				new BN(100).mul(QUOTE_PRECISION),
				new BN(1000).mul(QUOTE_PRECISION),
				new BN(10000).mul(QUOTE_PRECISION),
			],
		});

		const bids = Array.from(generator.getL2Bids());

		const totalBidSize = bids.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);

		console.log(
			'totalBidSize:',
			totalBidSize.toString(),
			'openBids:',
			openBids.toString()
		);
		assert(totalBidSize.sub(openBids).abs().lt(new BN(5)));

		const asks = Array.from(generator.getL2Asks());
		// console.log(asks);

		assert(asks.length == 1);
		console.log(asks[0].size.toString());
		const totalAskSize = asks.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);
		console.log(
			'totalAskSize:',
			totalAskSize.toString(),
			'openAsks:',
			openAsks.toString()
		);
		assert(totalAskSize.sub(openAsks.abs()).lte(new BN(5))); // only tiny rounding errors
	});

	it('orderbook L2 gen (no topOfBookQuoteAmounts, 10 numOrders, no liquidity)', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];
		const cc = 38104569;
		mockMarket1.amm.baseAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.marketStats.minOrderSize = new BN(5);
		mockMarket1.amm.maxBaseAssetReserve = mockMarket1.amm.baseAssetReserve.add(
			new BN(9)
		);
		mockMarket1.amm.minBaseAssetReserve = mockMarket1.amm.baseAssetReserve.sub(
			new BN(9)
		);
		mockMarket1.amm.quoteAssetReserve = new BN(cc).mul(BASE_PRECISION);
		mockMarket1.amm.pegMultiplier = new BN(18.32 * PEG_PRECISION.toNumber());
		mockMarket1.amm.sqrtK = new BN(cc).mul(BASE_PRECISION);

		const now = new BN(1688881915);

		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(18.624 * PRICE_PRECISION.toNumber()),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;
		mockMarket1.marketStats.historicalOracleData.lastOraclePrice = new BN(
			18.5535 * PRICE_PRECISION.toNumber()
		);

		const updatedAmm = calculateUpdatedAMM(mockMarket1.amm, mmOraclePriceData);

		const [openBids, openAsks] = calculateMarketOpenBidAsk(
			updatedAmm.baseAssetReserve,
			updatedAmm.minBaseAssetReserve,
			updatedAmm.maxBaseAssetReserve,
			mockMarket1.orderStepSize
		);

		const generator = getVammL2Generator({
			marketAccount: mockMarket1,
			mmOraclePriceData,
			numOrders: 10,
			now,
			topOfBookQuoteAmounts: [],
		});

		const bids = Array.from(generator.getL2Bids());
		// console.log(bids);

		const totalBidSize = bids.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);

		console.log(
			'totalBidSize:',
			totalBidSize.toString(),
			'openBids:',
			openBids.toString()
		);
		assert(openBids.eq(new BN(9)));
		assert(totalBidSize.eq(ZERO));

		const asks = Array.from(generator.getL2Asks());
		// console.log(asks);

		const totalAskSize = asks.reduce((total: BN, order: L2Level) => {
			return total.add(order.size);
		}, ZERO);
		console.log(
			'totalAskSize:',
			totalAskSize.toString(),
			'openAsks:',
			openAsks.toString()
		);

		assert(openAsks.eq(new BN(-9)));
		assert(totalAskSize.eq(ZERO));
	});

	it('Reference Price Offset accounts for oracle twap slow floor term', () => {
		// day-premium leg before averaging: 100000/1000*24 = 2400, then the
		// program subtracts oracleTwapSlow.abs()/FUNDING_RATE_OFFSET_DENOMINATOR
		// (500000/3333 = 150) => 2250. Without that term the average would be
		// 1800 instead of 1750.
		const reservePrice = PRICE_PRECISION;
		const last24hAvgFundingRate = new BN(100000);
		const liquidityFraction = new BN(2);
		const oracleTwapFast = new BN(500000);
		const markTwapFast = oracleTwapFast.add(new BN(1000));
		const oracleTwapSlow = new BN(500000);
		const markTwapSlow = oracleTwapSlow.add(new BN(2000));
		const maxOffsetPct = 100000;

		const referencePriceOffset = calculateReferencePriceOffset(
			reservePrice,
			last24hAvgFundingRate,
			liquidityFraction,
			oracleTwapFast,
			markTwapFast,
			oracleTwapSlow,
			markTwapSlow,
			maxOffsetPct
		);

		assert(referencePriceOffset.eq(new BN(1750)));
	});

	it('calculateUpdatedAMM is a passthrough when the repeg debit fails the affordability floor', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];
		const mockAmm = mockMarket1.amm;

		mockAmm.baseAssetReserve = new BN(1000).mul(BASE_PRECISION);
		mockAmm.quoteAssetReserve = new BN(1000).mul(BASE_PRECISION);
		mockAmm.sqrtK = new BN(1000).mul(BASE_PRECISION);
		mockAmm.pegMultiplier = new BN(10).mul(PEG_PRECISION);
		mockAmm.baseAssetAmountWithAmm = new BN(100).mul(BASE_PRECISION);
		mockAmm.curveUpdateIntensity = 100;
		mockAmm.maxSpread = 25000;
		// tiny positive equity: any positive repeg cost blows through it
		mockAmm.totalFeeMinusDistributions = new BN(10);
		mockAmm.netRevenueSinceLastFunding = new BN(0);

		const directionToClose = mockAmm.baseAssetAmountWithAmm.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;
		const [terminalQuoteAssetReserve] = calculateAmmReservesAfterSwap(
			mockAmm,
			'base',
			mockAmm.baseAssetAmountWithAmm.abs(),
			getSwapDirection('base', directionToClose)
		);
		mockAmm.terminalQuoteAssetReserve = terminalQuoteAssetReserve;

		// a 1% oracle move is well inside half of maxSpread (1.25%), so the
		// optimal-peg/budget calc doesn't take the large-price-gap escape
		// hatch that would otherwise clear checkLowerBound
		const mmOraclePriceData: MMOraclePriceData = {
			price: new BN(101).mul(PRICE_PRECISION).divn(10),
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;

		const updatedAmm = calculateUpdatedAMM(mockAmm, mmOraclePriceData);

		assert(updatedAmm.pegMultiplier.eq(mockAmm.pegMultiplier));
		assert(updatedAmm.baseAssetReserve.eq(mockAmm.baseAssetReserve));
		assert(updatedAmm.quoteAssetReserve.eq(mockAmm.quoteAssetReserve));
		assert(updatedAmm.sqrtK.eq(mockAmm.sqrtK));
		assert(
			updatedAmm.totalFeeMinusDistributions.eq(
				mockAmm.totalFeeMinusDistributions
			)
		);
	});

	it('calculateUpdatedAMM is a passthrough when the oracle price is non-positive', () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);
		const mockMarket1 = myMockPerpMarkets[0];
		const mockAmm = mockMarket1.amm;
		mockAmm.curveUpdateIntensity = 100;

		const mmOraclePriceData: MMOraclePriceData = {
			price: ZERO,
			slot: new BN(0),
			confidence: new BN(1),
			hasSufficientNumberOfDataPoints: true,
			isMMOracleActive: true,
		} as MMOraclePriceData;

		const updatedAmm = calculateUpdatedAMM(mockAmm, mmOraclePriceData);
		assert(updatedAmm.pegMultiplier.eq(mockAmm.pegMultiplier));
		assert(updatedAmm.baseAssetReserve.eq(mockAmm.baseAssetReserve));
		assert(updatedAmm.quoteAssetReserve.eq(mockAmm.quoteAssetReserve));
	});
});
