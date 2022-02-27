import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { BN } from '../sdk';

import {
	getFeedData,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
} from './testHelpers';

import {
	calculateMarkPrice,
	PEG_PRECISION,
	PositionDirection,
	QUOTE_PRECISION,
	calculateTargetPriceTrade,
	convertToNumber,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	FUNDING_PAYMENT_PRECISION,
	ClearingHouse,
	ClearingHouseUser,
} from '../sdk/src';

import { initUserAccounts } from '../stress/stressUtils';

async function updateFundingRateHelper(
	clearingHouse: ClearingHouse,
	marketIndex: BN,
	priceFeedAddress: PublicKey,
	prices: Array<number>
) {
	for (let i = 0; i < prices.length; i++) {
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const newprice = prices[i];
		setFeedPrice(anchor.workspace.Pyth, newprice, priceFeedAddress);

		const marketsAccount0 = await clearingHouse.getMarketsAccount();
		const marketData0 = marketsAccount0.markets[marketIndex.toNumber()];
		const ammAccountState0 = marketData0.amm;
		const oraclePx0 = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState0.oracle
		);

		const priceSpread0 =
			convertToNumber(ammAccountState0.lastMarkPriceTwap) - oraclePx0.twap;
		const frontEndFundingCalc0 = priceSpread0 / oraclePx0.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc0:',
			frontEndFundingCalc0,
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber(),
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber(),
			'oracleTwap0:',
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

		const marketsAccount = await clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;
		const peroidicity = marketData.amm.fundingPeriod;

		const lastFundingRate = convertToNumber(
			ammAccountState.lastFundingRate,
			CONVERSION_SCALE
		);

		console.log('last funding rate:', lastFundingRate);
		console.log(
			'cumfunding rate:',
			convertToNumber(ammAccountState.cumulativeFundingRate, CONVERSION_SCALE),
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
		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingShort.abs()));

		const oraclePx = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState.oracle
		);

		const priceSpread =
			ammAccountState.lastMarkPriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber() -
			oraclePx.twap;
		const frontEndFundingCalc =
			priceSpread / ((24 * 3600) / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',
			frontEndFundingCalc,
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber() /
				MARK_PRICE_PRECISION.toNumber(),
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber(),
			'oracleTwap:',
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

describe('pyth-oracle', () => {
	const provider = anchor.Provider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;

	anchor.setProvider(provider);
	const program = anchor.workspace.Pyth;

	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouse2: ClearingHouse;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13);

	const usdcAmount = new BN(10 * 10 ** 6);

	let userAccount: ClearingHouseUser;
	let userAccount2: ClearingHouseUser;
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

		const price = 50000;
		await mockOracle(price, -6);

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
		// 	await userAccount2.getPublicKey(),
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

	it('change feed price', async () => {
		const price = 50000;
		const expo = -9;
		const priceFeedAddress = await mockOracle(price, expo);

		const feedDataBefore = await getFeedData(program, priceFeedAddress);
		assert.ok(feedDataBefore.price === price);
		assert.ok(feedDataBefore.exponent === expo);
		const newPrice = 55000;

		await setFeedPrice(program, newPrice, priceFeedAddress);
		const feedDataAfter = await getFeedData(program, priceFeedAddress);
		assert.ok(feedDataAfter.price === newPrice);
		assert.ok(feedDataAfter.exponent === expo);
	});

	it('oracle/vamm: funding rate calc 0hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -10);
		const periodicity = new BN(0); // 1 HOUR
		const marketIndex = new BN(0);

		await clearingHouse.initializeMarket(
			marketIndex,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(39.99 * PEG_PRECISION.toNumber())
		);

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[42]
		);
	});

	it('oracle/vamm: funding rate calc2 0hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -10);
		const periodicity = new BN(0);
		const marketIndex = new BN(1);

		await clearingHouse.initializeMarket(
			marketIndex,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(41.7 * PEG_PRECISION.toNumber())
		);

		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(41.5 * MARK_PRICE_PRECISION.toNumber())
		// );

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[41.501, 41.499]
		);
	});

	it('oracle/vamm: asym funding rate calc 0hour periodicity', async () => {
		const marketIndex = new BN(1);

		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(41.5 * MARK_PRICE_PRECISION.toNumber())
		// );

		console.log(
			'PRICE',
			convertToNumber(calculateMarkPrice(clearingHouse.getMarket(marketIndex)))
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			QUOTE_PRECISION,
			marketIndex
		);

		await clearingHouse2.openPosition(
			PositionDirection.SHORT,
			QUOTE_PRECISION.div(new BN(2)),
			marketIndex
		);

		const market =
			clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()];

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			market.amm.oracle,
			[41.501, 41.499]
		);

		const marketNew =
			clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()];

		const fundingRateLong = marketNew.amm.cumulativeFundingRateLong.sub(
			market.amm.cumulativeFundingRateLong
		);
		const fundingRateShort = marketNew.amm.cumulativeFundingRateShort.sub(
			market.amm.cumulativeFundingRateShort
		);

		// more dollars long than short
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));
		// assert(fundingRateShort.gt(fundingRateLong));
	});

	it('new LONG trade above oracle-mark limit fails', async () => {
		const marketIndex = new BN(1);

		const market =
			clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()];
		const baseAssetPriceWithMantissa = calculateMarkPrice(market);

		const targetPriceDefaultSlippage = baseAssetPriceWithMantissa.add(
			baseAssetPriceWithMantissa.div(new BN(11))
		); // < 10% increase

		console.log(
			'SUCCEEDS: price from',
			convertToNumber(baseAssetPriceWithMantissa),
			'->',
			convertToNumber(targetPriceDefaultSlippage)
		);
		const [_directionSuc, _tradeSizeSuc, _entryPriceSuc] =
			calculateTargetPriceTrade(
				clearingHouse.getMarket(marketIndex),
				BN.max(targetPriceDefaultSlippage, new BN(1))
			);
		// await clearingHouse.openPosition(
		// 	PositionDirection.LONG,
		// 	tradeSizeSuc,
		// 	marketIndex
		// );
		// await clearingHouse.closePosition(
		// 	marketIndex
		// );

		const targetPriceFails = baseAssetPriceWithMantissa.add(
			baseAssetPriceWithMantissa.div(new BN(9))
		); // > 10% increase
		console.log(
			'FAILS: price from',
			convertToNumber(baseAssetPriceWithMantissa),
			'->',
			convertToNumber(targetPriceFails)
		);

		const [_direction, tradeSize, _entryPrice] = calculateTargetPriceTrade(
			clearingHouse.getMarket(marketIndex),
			BN.max(targetPriceFails, new BN(1))
		);

		try {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				tradeSize,
				marketIndex
			);
			assert(false, 'Order succeeded');
		} catch (e) {
			if (e.message == 'Order succeeded') {
				assert(false, 'Order succeeded');
			}
			assert(true);
		}
	});
});
