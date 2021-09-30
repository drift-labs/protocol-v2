import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import BN from 'bn.js';

import {
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
} from '../utils/mockAccounts';
import { getFeedData, setFeedPrice } from '../utils/mockPythUtils';
import { PEG_SCALAR, stripMantissa } from "../sdk";

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { AMM_MANTISSA, FUNDING_MANTISSA, ClearingHouse } from '../sdk/src';

async function updateFundingRateHelper(
	clearingHouse: ClearingHouse,
	marketIndex: BN,
	priceFeedAddress: PublicKey,
	prices: Array<number>,
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

		const priceSpread0 = (stripMantissa(ammAccountState0.lastMarkPriceTwap) -
			oraclePx0.twap);
		const frontEndFundingCalc0 = priceSpread0 / oraclePx0.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc0:',

			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber() / AMM_MANTISSA.toNumber(),
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber(),
			'oracleTwap0:',
			oraclePx0.twap,
			priceSpread0,
			frontEndFundingCalc0
		);

		const _tx = await clearingHouse.updateFundingRate(
			priceFeedAddress,
			marketIndex
		);

		const CONVERSION_SCALE = (FUNDING_MANTISSA).mul(AMM_MANTISSA);

		const marketsAccount = await clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;
		const peroidicity = marketData.amm.fundingPeriod;

		const lastFundingRate = stripMantissa(ammAccountState.lastFundingRate, CONVERSION_SCALE);

		console.log(
			'last funding rate:',
			lastFundingRate
		);
		console.log(
			'cumfunding rate:',
			stripMantissa(ammAccountState.cumulativeFundingRate, CONVERSION_SCALE)
		);
		

		const oraclePx = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState.oracle
		);

		const priceSpread =
			ammAccountState.lastMarkPriceTwap.toNumber() / AMM_MANTISSA.toNumber() - oraclePx.twap;
		const frontEndFundingCalc = priceSpread / (24 * 3600 / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',

			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber() / AMM_MANTISSA.toNumber(),
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber(),
			'oracleTwap:',
			oraclePx.twap,
			priceSpread,
			frontEndFundingCalc
		);
		const s = new Date(ammAccountState.lastMarkPriceTwapTs.toNumber() * 1000);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);

		// assert(Math.abs(frontEndFundingCalc - lastFundingRate) < 9e-6);
	}
}

describe('pyth-oracle', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;

	anchor.setProvider(provider);
	const program = anchor.workspace.Pyth;

	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let usdcMint;
	let _userUSDCAccount;

	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 10);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 10);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		_userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider
		);

		clearingHouse = new ClearingHouse(
			connection,
			provider.wallet,
			chProgram.programId
		);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const price = 50000;
		await mockOracle(price, -6);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
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
			new BN(30*PEG_SCALAR.toNumber())
		);

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[40]
		);
	});

	it('oracle/vamm: funding rate calc 0hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -10);
		const periodicity = new BN(0);
		const marketIndex = new BN(1);

		await clearingHouse.initializeMarket(
			marketIndex,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(41.5*PEG_SCALAR.toNumber())
		);

		await clearingHouse.moveAmmToPrice(marketIndex, new BN(41.5 * AMM_MANTISSA.toNumber()));

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[41.501, 41.499],
		);
	});
});
