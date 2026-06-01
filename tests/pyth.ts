import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { BASE_PRECISION, BN } from '../sdk';

import {
	mockOracleNoProgram,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
	initUserAccounts,
	getFeedDataNoProgram,
} from './testHelpers';
import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	calculateReservePrice,
	PEG_PRECISION,
	PositionDirection,
	convertToNumber,
	MarketStatus,
	PRICE_PRECISION,
	FUNDING_RATE_BUFFER_PRECISION,
	TestClient,
	User,
	QUOTE_SPOT_MARKET_INDEX,
} from '../sdk/src';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

async function updateFundingRateHelper(
	driftClient: TestClient,
	marketIndex: number,
	priceFeedAddress: PublicKey,
	prices: Array<number>,
	context: BankrunContextWrapper,
	txNonce = 0 // helps prevent race conditions with identical transactions
) {
	for (let i = 0; i < prices.length; i++) {
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const newprice = prices[i];
		setFeedPriceNoProgram(context, newprice, priceFeedAddress);

		const marketData0 = driftClient.getPerpMarketAccount(marketIndex);
		const ammAccountState0 = marketData0.amm;
		const oraclePx0 = await getFeedDataNoProgram(
			// @ts-ignore
			context.connection,
			marketData0.oracle
		);

		const priceSpread0 =
			convertToNumber(marketData0.marketStats.lastMarkPriceTwap) -
			convertToNumber(
				marketData0.marketStats.historicalOracleData.lastOraclePriceTwap
			);
		const frontEndFundingCalc0 = priceSpread0 / oraclePx0.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc0:',
			frontEndFundingCalc0,
			'markTwap0:',
			marketData0.marketStats.lastMarkPriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'markTwap0:',
			marketData0.marketStats.lastMarkPriceTwap.toNumber(),
			'oracleTwap0(vamm):',
			marketData0.marketStats.historicalOracleData.lastOraclePriceTwap.toNumber(),
			'oracleTwap0:',
			oraclePx0.twap,
			'oraclePrice',
			oraclePx0.price,
			'priceSpread',
			priceSpread0
		);

		const cumulativeFundingRateLongOld =
			marketData0.cumulativeFundingRateLong;
		const cumulativeFundingRateShortOld =
			marketData0.cumulativeFundingRateShort;
		try {
			driftClient.txParams.computeUnits = 600_000 + txNonce;
			const _tx = await driftClient.updateFundingRate(
				marketIndex,
				priceFeedAddress
			);
		} catch (e) {
			console.error(e);
		}

		const CONVERSION_SCALE = FUNDING_RATE_BUFFER_PRECISION.mul(PRICE_PRECISION);

		const marketData = driftClient.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		const peroidicity = marketData.marketStats.fundingPeriod;

		const lastFundingRate = convertToNumber(
			marketData.lastFundingRate,
			CONVERSION_SCALE
		);

		console.log('last funding rate:', lastFundingRate);
		console.log(
			'cumfunding rate:',
			convertToNumber(ammAccountState.cumulativeFundingRate, CONVERSION_SCALE),
			'cumfunding rate long',
			convertToNumber(
				marketData.cumulativeFundingRateLong,
				CONVERSION_SCALE
			),
			'cumfunding rate short',
			convertToNumber(
				marketData.cumulativeFundingRateShort,
				CONVERSION_SCALE
			)
		);

		const lastFundingLong = marketData.cumulativeFundingRateLong
			.sub(cumulativeFundingRateLongOld)
			.abs();
		const lastFundingShort = marketData.cumulativeFundingRateShort
			.sub(cumulativeFundingRateShortOld)
			.abs();

		assert(marketData.lastFundingRate.abs().gte(lastFundingLong.abs()));
		assert(marketData.lastFundingRate.abs().gte(lastFundingShort.abs()));

		const priceSpread =
			(marketData.marketStats.lastMarkPriceTwap.toNumber() -
				marketData.marketStats.historicalOracleData.lastOraclePriceTwap.toNumber()) /
			PRICE_PRECISION.toNumber();
		const frontEndFundingCalc =
			priceSpread / ((24 * 3600) / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',
			frontEndFundingCalc,
			'markTwap:',
			marketData.marketStats.lastMarkPriceTwap.toNumber() / PRICE_PRECISION.toNumber(),
			'markTwap:',
			marketData.marketStats.lastMarkPriceTwap.toNumber(),
			'oracleTwap(vamm):',
			marketData.marketStats.historicalOracleData.lastOraclePriceTwap.toNumber(),
			'priceSpread:',
			priceSpread
		);
		const s = new Date(marketData.marketStats.lastMarkPriceTwapTs.toNumber() * 1000);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);

		// assert(Math.abs(frontEndFundingCalc - lastFundingRate) < 9e-6);
	}
}

describe('pyth-oracle', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let driftClient2: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13);

	const usdcAmount = new BN(10 * 10 ** 6);

	let userAccount: User;
	let userAccount2: User;
	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const price = 50000;
		await mockOracleNoProgram(bankrunContextWrapper, price, -6);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: [0],
			subAccountIds: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		await driftClient.initializeUserAccount();
		userAccount = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userAccount.subscribe();

		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const [_userUSDCAccounts, _user_keys, driftClients, userAccountInfos] =
			await initUserAccounts(
				1,
				usdcMint,
				usdcAmount,
				bankrunContextWrapper,
				[0, 1],
				[0],
				[],
				bulkAccountLoader
			);

		driftClient2 = driftClients[0];
		userAccount2 = userAccountInfos[0];

		// await driftClient.depositCollateral(
		// 	await userAccount2.getPublicKey(),
		// 	usdcAmount,
		// 	userUSDCAccounts[1].publicKey
		// );
	});

	after(async () => {
		await driftClient.unsubscribe();
		await userAccount.unsubscribe();

		await driftClient2.unsubscribe();
		await userAccount2.unsubscribe();
	});

	it('change feed price', async () => {
		const price = 50000;
		const expo = -9;
		const priceFeedAddress = await mockOracleNoProgram(
			bankrunContextWrapper,
			price,
			expo
		);

		const feedDataBefore = await getFeedDataNoProgram(
			bankrunContextWrapper.connection,
			priceFeedAddress
		);
		assert.ok(feedDataBefore.price === price);
		assert.ok(feedDataBefore.exponent === expo);
		const newPrice = 55000;

		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			newPrice,
			priceFeedAddress
		);
		const feedDataAfter = await getFeedDataNoProgram(
			bankrunContextWrapper.connection,
			priceFeedAddress
		);
		assert.ok(feedDataAfter.price === newPrice);
		assert.ok(feedDataAfter.exponent === expo);
	});

	it('oracle/vamm: funding rate calc 0hour periodicity', async () => {
		await bankrunContextWrapper.moveTimeForward(2);
		const priceFeedAddress = await mockOracleNoProgram(
			bankrunContextWrapper,
			40,
			-10
		);
		const periodicity = new BN(0); // 1 HOUR
		const marketIndex = 0;

		await driftClient.initializePerpMarket(
			0,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(39.99 * PEG_PRECISION.toNumber())
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await updateFundingRateHelper(
			driftClient,
			marketIndex,
			priceFeedAddress,
			[42],
			bankrunContextWrapper,
			1
		);
	});

	it('oracle/vamm: funding rate calc2 0hour periodicity', async () => {
		await bankrunContextWrapper.moveTimeForward(2);
		const priceFeedAddress = await mockOracleNoProgram(
			bankrunContextWrapper,
			40,
			-10
		);
		const periodicity = new BN(0);
		const marketIndex = 1;

		await driftClient.initializePerpMarket(
			1,
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(41.7 * PEG_PRECISION.toNumber())
		);
		await driftClient.updatePerpMarketStatus(marketIndex, MarketStatus.ACTIVE);

		// await driftClient.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(41.5 * PRICE_PRECISION.toNumber())
		// );

		await updateFundingRateHelper(
			driftClient,
			marketIndex,
			priceFeedAddress,
			[41.501, 41.499],
			bankrunContextWrapper,
			2
		);
	});

	it('oracle/vamm: asym funding rate calc 0hour periodicity', async () => {
		const marketIndex = 1;

		// await driftClient.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(41.5 * PRICE_PRECISION.toNumber())
		// );

		console.log(
			'PRICE',
			convertToNumber(
				calculateReservePrice(
					driftClient.getPerpMarketAccount(marketIndex),
					driftClient.getOracleDataForPerpMarket(marketIndex)
				)
			)
		);

		driftClient.txParams.computeUnits = 600_003;
		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);

		driftClient.txParams.computeUnits = 600_004;
		await driftClient2.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION.div(new BN(100)),
			marketIndex
		);
		await driftClient.fetchAccounts();

		const market = driftClient.getPerpMarketAccount(marketIndex);

		console.log(
			'PRICE AFTER',
			convertToNumber(
				calculateReservePrice(
					market,
					driftClient.getOracleDataForPerpMarket(marketIndex)
				)
			)
		);

		await updateFundingRateHelper(
			driftClient,
			marketIndex,
			market.oracle,
			[43.501, 44.499],
			bankrunContextWrapper,
			3
		);
		await driftClient.fetchAccounts();

		const marketNew = driftClient.getPerpMarketAccount(marketIndex);

		console.log(
			'lastOraclePriceTwap before:',
			market.marketStats.historicalOracleData.lastOraclePriceTwap.toString()
		);
		console.log(
			'lastMarkPriceTwap before:',
			market.marketStats.lastMarkPriceTwap.toString()
		);

		console.log(
			'lastOraclePriceTwap after:',
			marketNew.marketStats.historicalOracleData.lastOraclePriceTwap.toString()
		);
		console.log(
			'lastMarkPriceTwap after:',
			marketNew.marketStats.lastMarkPriceTwap.toString()
		);

		const fundingRateLong = marketNew.cumulativeFundingRateLong.sub(
			market.cumulativeFundingRateLong
		);
		console.log(
			marketNew.cumulativeFundingRateLong.toString(),
			market.cumulativeFundingRateLong.toString(),
			marketNew.cumulativeFundingRateShort.toString(),
			market.cumulativeFundingRateShort.toString()
		);
		const fundingRateShort = marketNew.cumulativeFundingRateShort.sub(
			market.cumulativeFundingRateShort
		);

		// more dollars long than short
		console.log(fundingRateLong.toString(), 'vs', fundingRateShort.toString());
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0))); // Z-TODO
		assert(fundingRateShort.abs().gte(fundingRateLong.abs()));
	});
});
