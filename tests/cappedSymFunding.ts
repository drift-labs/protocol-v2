import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { BN } from '../sdk';

import {
	getFeedData,
	initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
} from './testHelpers';
import {
	Admin,
	MARK_PRICE_PRECISION,
	FUNDING_PAYMENT_PRECISION,
	PEG_PRECISION,
	ClearingHouse,
	ClearingHouseUser,
	PositionDirection,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
	calculateMarkPrice,
	convertToNumber,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

async function updateFundingRateHelper(
	clearingHouse: ClearingHouse,
	marketIndex: BN,
	priceFeedAddress: PublicKey,
	prices: Array<number>
) {
	for (let i = 0; i < prices.length; i++) {
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const newprice = prices[i];
		await setFeedPrice(anchor.workspace.Pyth, newprice, priceFeedAddress);
		// just to update funding trade .1 cent
		// await clearingHouse.openPosition(
		// 	PositionDirection.LONG,
		// 	QUOTE_PRECISION.div(new BN(100)),
		// 	marketIndex
		// );
		const marketsAccount0 = clearingHouse.getMarketsAccount();
		const marketData0 = marketsAccount0.markets[marketIndex.toNumber()];
		const ammAccountState0 = marketData0.amm;
		const oraclePx0 = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState0.oracle
		);

		const priceSpread0 =
			convertToNumber(ammAccountState0.lastMarkPriceTwap) -
			convertToNumber(ammAccountState0.lastOraclePriceTwap);
		const frontEndFundingCalc0 = priceSpread0 / oraclePx0.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc0:',
			frontEndFundingCalc0,
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber(),
			'oracleTwap0:',
			ammAccountState0.lastOraclePriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber(),
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber(),
			'oracleTwapPyth:',
			oraclePx0.twap,
			'priceSpread',
			priceSpread0
		);

		const cumulativeFundingRateLongOld =
			ammAccountState0.cumulativeFundingRateLong;
		const cumulativeFundingRateShortOld =
			ammAccountState0.cumulativeFundingRateShort;

		const _tx = await clearingHouse.updateFundingRate(
			priceFeedAddress,
			marketIndex
		);

		const CONVERSION_SCALE =
			FUNDING_PAYMENT_PRECISION.mul(MARK_PRICE_PRECISION);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;
		const peroidicity = marketData.amm.fundingPeriod;

		const lastFundingRate = convertToNumber(
			ammAccountState.lastFundingRate,
			CONVERSION_SCALE
		);

		console.log('last funding rate:', lastFundingRate);
		console.log(
			'cumfunding rate long',
			convertToNumber(
				ammAccountState.cumulativeFundingRateLong,
				CONVERSION_SCALE
			),
			'cumfunding rate short',
			convertToNumber(
				ammAccountState.cumulativeFundingRateShort,
				CONVERSION_SCALE
			)
		);

		const lastFundingLong = ammAccountState.cumulativeFundingRateLong
			.sub(cumulativeFundingRateLongOld)
			.abs();
		const lastFundingShort = ammAccountState.cumulativeFundingRateShort
			.sub(cumulativeFundingRateShortOld)
			.abs();

		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingLong.abs()));
		console.log(
			convertToNumber(ammAccountState.lastFundingRate.abs()) /
				FUNDING_PAYMENT_PRECISION.toNumber(),
			'>=',
			convertToNumber(lastFundingShort.abs()) /
				FUNDING_PAYMENT_PRECISION.toNumber()
		);
		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingShort.abs()));

		const oraclePx = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState.oracle
		);

		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const priceSpread =
			ammAccountState.lastMarkPriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber() -
			ammAccountState.lastOraclePriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber();
		const frontEndFundingCalc =
			priceSpread / ((24 * 3600) / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',
			frontEndFundingCalc,
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber(),
			'oracleTwap:',
			ammAccountState.lastOraclePriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber(),
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber(),
			'oracleTwapPyth:',
			oraclePx.twap,
			'priceSpread:',
			priceSpread
		);
		const s = new Date(ammAccountState.lastMarkPriceTwapTs.toNumber() * 1000);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);

		// assert(Math.abs(frontEndFundingCalc - lastFundingRate) < 9e-6);
	}
}

async function cappedSymFundingScenario(
	clearingHouse: Admin,
	userAccount: ClearingHouseUser,
	clearingHouse2: ClearingHouse,
	userAccount2: ClearingHouseUser,
	marketIndex: BN,
	kSqrt: BN,
	priceAction: Array<number>,
	longShortSizes: Array<number>,
	fees = 0
) {
	const priceFeedAddress = await mockOracle(priceAction[1], -10);
	const periodicity = new BN(0);

	await clearingHouse.initializeMarket(
		marketIndex,
		priceFeedAddress,
		kSqrt,
		kSqrt,
		periodicity,
		new BN(priceAction[0] * PEG_PRECISION.toNumber())
	);

	if (fees && fees > 0) {
		await clearingHouse.updateFundingPaused(true);

		console.log('spawn some fee pool');

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			QUOTE_PRECISION.mul(new BN(5000)),
			marketIndex
		);
		await clearingHouse.closePosition(marketIndex);
		await clearingHouse.updateFundingPaused(false);
	}

	console.log(
		'PRICE',
		convertToNumber(calculateMarkPrice(clearingHouse.getMarket(marketIndex)))
	);
	await clearingHouse.updateFundingPaused(true);

	await clearingHouse.fetchAccounts();
	if (longShortSizes[0] !== 0) {
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			QUOTE_PRECISION.mul(new BN(longShortSizes[0])),
			marketIndex
		);
	}

	console.log('clearingHouse2.openPosition');
	await clearingHouse2.fetchAccounts();
	// try{
	if (longShortSizes[1] !== 0) {
		await clearingHouse2.openPosition(
			PositionDirection.SHORT,
			QUOTE_PRECISION.mul(new BN(longShortSizes[1])),
			marketIndex
		);
	}
	console.log(longShortSizes[0], longShortSizes[1]);
	await userAccount.fetchAccounts();
	if (longShortSizes[0] != 0) {
		assert(!userAccount.getTotalPositionValue().eq(new BN(0)));
	} else {
		assert(userAccount.getTotalPositionValue().eq(new BN(0)));
	}
	await userAccount2.fetchAccounts();
	if (longShortSizes[1] != 0) {
		assert(!userAccount2.getTotalPositionValue().eq(new BN(0)));
	} else {
		assert(userAccount2.getTotalPositionValue().eq(new BN(0)));
	}

	// } catch(e){
	// }
	console.log('clearingHouse.getMarketsAccount');

	const market = await clearingHouse.getMarketsAccount().markets[
		marketIndex.toNumber()
	];

	await clearingHouse.updateFundingPaused(false);

	console.log('priceAction update', priceAction, priceAction.slice(1));
	await updateFundingRateHelper(
		clearingHouse,
		marketIndex,
		market.amm.oracle,
		priceAction.slice(1)
	);

	const marketNew = await clearingHouse.getMarketsAccount().markets[
		marketIndex.toNumber()
	];

	const fundingRateLong = marketNew.amm.cumulativeFundingRateLong; //.sub(prevFRL);
	const fundingRateShort = marketNew.amm.cumulativeFundingRateShort; //.sub(prevFRS);

	console.log(
		'fundingRateLong',
		convertToNumber(
			fundingRateLong,
			MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
		),
		'fundingRateShort',
		convertToNumber(
			fundingRateShort,
			MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
		)
	);
	console.log(
		'baseAssetAmountLong',
		convertToNumber(marketNew.baseAssetAmountLong, AMM_RESERVE_PRECISION),
		'baseAssetAmountShort',
		convertToNumber(marketNew.baseAssetAmountShort, AMM_RESERVE_PRECISION),
		'totalFee',
		convertToNumber(marketNew.amm.totalFee, QUOTE_PRECISION),
		'totalFeeMinusDistributions',
		convertToNumber(marketNew.amm.totalFeeMinusDistributions, QUOTE_PRECISION)
	);

	const fundingPnLForLongs = marketNew.baseAssetAmountLong
		.mul(fundingRateLong)
		.mul(new BN(-1));
	const fundingPnLForShorts = marketNew.baseAssetAmountShort
		.mul(fundingRateShort)
		.mul(new BN(-1));

	const precisionFundingPay = AMM_RESERVE_PRECISION;
	console.log(
		'fundingPnLForLongs',
		convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		),
		'fundingPnLForShorts',
		convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		)
	);

	// more dollars long than short
	assert(!fundingRateLong.eq(new BN(0)));
	assert(!fundingRateShort.eq(new BN(0)));

	assert(fundingRateShort.lte(fundingRateLong));
	if (longShortSizes[0] !== 0) {
		await clearingHouse.closePosition(marketIndex);
	}
	if (longShortSizes[1] !== 0) {
		await clearingHouse2.closePosition(marketIndex);
	}

	return [
		fundingRateLong,
		fundingRateShort,
		fundingPnLForLongs,
		fundingPnLForShorts,
		marketNew.amm.totalFee,
		marketNew.amm.totalFeeMinusDistributions,
	];
}

describe('capped funding', () => {
	const provider = anchor.Provider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;

	anchor.setProvider(provider);

	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouse2: ClearingHouse;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		MARK_PRICE_PRECISION
	);

	const usdcAmount = new BN(10000 * 10 ** 6);

	let userAccount: ClearingHouseUser;
	let userAccount2: ClearingHouseUser;

	let rollingMarketNum = 0;
	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();

		await clearingHouse.depositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const [_userUSDCAccounts, _user_keys, clearingHouses, userAccountInfos] =
			await initUserAccounts(1, usdcMint, usdcAmount, provider);

		clearingHouse2 = clearingHouses[0];
		userAccount2 = userAccountInfos[0];

		// await clearingHouse.depositCollateral(
		// 	await userAccount2.getUserAccountPublicKey(),
		// 	usdcAmount,
		// 	userUSDCAccounts[1].publicKey
		// );
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();

		await clearingHouse2.unsubscribe();
		await userAccount2.unsubscribe();
	});

	it('capped sym funding: ($1 long, $200 short, oracle < mark)', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;
		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[40, 36.5],
			[1, 200]
		);

		assert(fundingRateLong.abs().gt(fundingRateShort.abs()));
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));

		assert(fundingPnLForLongs.abs().lt(fundingPnLForShorts.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForLongsNum),
			'>=',
			fundingPnLForShortsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForLongsNum) >= fundingPnLForShortsNum
		);
	});

	it('capped sym funding: ($0 long, $200 short, oracle < mark)', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[40, 36.5],
			[0, 200]
		);

		assert(fundingRateLong.abs().gt(fundingRateShort.abs()));
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));

		assert(fundingPnLForLongs.abs().lt(fundingPnLForShorts.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForLongsNum),
			'>=',
			fundingPnLForShortsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForLongsNum) >= fundingPnLForShortsNum
		);
	});
	it('capped sym funding: ($1 long, $200 short, oracle > mark)', async () => {
		// symmetric is taking fees

		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[40, 43.5],
			[1, 200]
		);

		assert(fundingRateLong.abs().eq(fundingRateShort.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.abs().lt(fundingPnLForShorts.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForLongsNum),
			'>=',
			fundingPnLForShortsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForLongsNum) >= fundingPnLForShortsNum
		);
	});
	it('capped sym funding: ($200 long, $1 short, oracle > mark)', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 42.5],
			[200, 1]
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
	it('capped sym funding: ($2000 long, $1000 short, oracle > mark), clamped to ~3.03% price spread', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 44.5],
			[2000, 1000],
			10000
		);

		//ensure it was clamped :)
		const marketNew = await clearingHouse.getMarketsAccount().markets[
			marketIndex.toNumber()
		];
		const clampedFundingRatePct = new BN(
			(0.03 * MARK_PRICE_PRECISION.toNumber()) / 24
		).mul(FUNDING_PAYMENT_PRECISION);
		const clampedFundingRate = marketNew.amm.lastOraclePriceTwap
			.mul(FUNDING_PAYMENT_PRECISION)
			.div(new BN(24))
			.div(new BN(33));
		console.log(
			'clamped funding:',
			convertToNumber(clampedFundingRate) /
				FUNDING_PAYMENT_PRECISION.toNumber(),
			'hourly pct:',
			convertToNumber(clampedFundingRatePct) /
				FUNDING_PAYMENT_PRECISION.toNumber()
		);
		console.log(
			'short funding:',
			convertToNumber(fundingRateShort) / FUNDING_PAYMENT_PRECISION.toNumber()
		);

		assert(fundingRateShort.abs().eq(fundingRateLong.abs()));
		assert(fundingRateShort.abs().lt(clampedFundingRate));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			Math.abs(
				feeAlloced + Math.abs(fundingPnLForShortsNum) - fundingPnLForLongsNum
			) < 1e-6
		);
	});
	it('capped sym funding: ($20000 long, $1000 short, oracle > mark), clamped to ~3.03% price spread, fee pool drain', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 45.1],
			[20000, 1000]
		);

		//ensure it was clamped :)
		const marketNew = await clearingHouse.getMarketsAccount().markets[
			marketIndex.toNumber()
		];
		const clampedFundingRatePct = new BN(
			(0.03 * MARK_PRICE_PRECISION.toNumber()) / 24
		).mul(FUNDING_PAYMENT_PRECISION);
		const clampedFundingRate = marketNew.amm.lastOraclePriceTwap
			.mul(FUNDING_PAYMENT_PRECISION)
			.div(new BN(24))
			.div(new BN(33));
		console.log(
			'clamped funding:',
			convertToNumber(clampedFundingRate) /
				FUNDING_PAYMENT_PRECISION.toNumber(),
			'hourly pct:',
			convertToNumber(clampedFundingRatePct) /
				FUNDING_PAYMENT_PRECISION.toNumber()
		);
		console.log(
			'short funding:',
			convertToNumber(fundingRateShort) / FUNDING_PAYMENT_PRECISION.toNumber()
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateShort.abs().lt(clampedFundingRate));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		assert(cumulativeFee.gt(totalFee.div(new BN(2))));
		assert(
			cumulativeFee.gt(totalFee.mul(new BN(2)).div(new BN(3)).sub(new BN(1)))
		);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >=
				fundingPnLForLongsNum + 1e-6
		);
	});
	it('capped sym funding: ($2000 long, $1000 short, oracle > mark)', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 43.8],
			[2000, 1000]
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
	it('capped sym funding: ($200 long, $0 short, oracle > mark)', async () => {
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 42.5],
			[200, 0]
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.eq(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
	it('capped sym funding: ($200 long, $1 short, oracle < mark)', async () => {
		//symmetric is taking fees
		const marketIndex = new BN(rollingMarketNum);
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 38.5],
			[200, 1]
		);

		assert(fundingRateShort.abs().eq(fundingRateLong.abs()));
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));

		assert(fundingPnLForLongs.lt(new BN(0)));
		assert(fundingPnLForShorts.gt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				MARK_PRICE_PRECISION.mul(FUNDING_PAYMENT_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
});
