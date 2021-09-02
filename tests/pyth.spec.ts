import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import BN from 'bn.js';

import {
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
} from '../utils/mockAccounts';
import { getFeedData, setFeedPrice } from '../utils/mockPythUtils';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { AMM_MANTISSA, ClearingHouse, Network } from '../sdk/src';

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

		const tx = await clearingHouse.updateFundingRate(
			priceFeedAddress,
			marketIndex
		);

		const CONVERSION_SCALE = AMM_MANTISSA.toNumber();

		const marketsAccount = await clearingHouse.getMarketsAccount();
		const marketData = marketsAccount.markets[marketIndex.toNumber()];
		const ammAccountState = marketData.amm;

		console.log(
			'last funding rate:',
			ammAccountState.fundingRate.toNumber() / CONVERSION_SCALE
		);
		console.log(
			'cumfunding rate:',
			ammAccountState.cumFundingRate.toNumber() / CONVERSION_SCALE
		);

		const oraclePx = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState.oracle
		);

		const priceSpread =
			ammAccountState.markTwap.toNumber() / AMM_MANTISSA.toNumber() -
			oraclePx.twap;
		const frontEndFundingCalc = priceSpread / oraclePx.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc:',

			'markTwap:',
			ammAccountState.markTwap.toNumber() / AMM_MANTISSA.toNumber(),
			'markTwap:',
			ammAccountState.markTwap.toNumber(),
			'oracleTwap:',
			oraclePx.twap,
			priceSpread,
			frontEndFundingCalc
		);

		const s = new Date(ammAccountState.fundingRateTs.toNumber() * 1000);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);
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
	let userUSDCAccount;

	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 10);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 10);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = new ClearingHouse(
			connection,
			Network.LOCAL,
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
		const expo = -10;
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

	it('oracle/vamm: funding rate calc 1hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -9);
		const periodicity = new BN(60 * 60); // 1 HOUR
		const marketIndex = new BN(0);

		await clearingHouse.initializeMarket(
			marketIndex,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[40]
		);
	});

	it('oracle/vamm: funding rate calc 0hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -9);
		const periodicity = new BN(0);
		const marketIndex = new BN(1);

		await clearingHouse.initializeMarket(
			marketIndex,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		await clearingHouse.moveAmmToPrice(marketIndex, new BN(41500000));

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[41.501, 41.499]
		);
	});
});
