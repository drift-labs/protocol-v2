import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import {
	getFeedData,
	initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	initializeQuoteSpotMarket,
	sleep,
	printTxLogs,
} from './testHelpers';
import {
	TestClient,
	BN,
	QUOTE_SPOT_MARKET_INDEX,
	PRICE_PRECISION,
	FUNDING_RATE_BUFFER_PRECISION,
	PEG_PRECISION,
	User,
	PositionDirection,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
	calculateReservePrice,
	convertToNumber,
	ExchangeStatus,
	BASE_PRECISION,
	OracleSource,
	isVariant,
	ContractTier,
} from '../../packages/sdk/src';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

async function updateFundingRateHelper(
	velocityClient: TestClient,
	marketIndex: number,
	priceFeedAddress: PublicKey,
	prices: Array<number>
) {
	for (let i = 0; i < prices.length; i++) {
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const newprice = prices[i];
		await setFeedPrice(anchor.workspace.Pyth, newprice, priceFeedAddress);
		// just to update funding trade .1 cent
		// await velocityClient.openPosition(
		// 	PositionDirection.LONG,
		// 	QUOTE_PRECISION.div(new BN(100)),
		// 	marketIndex
		// );
		await velocityClient.fetchAccounts();
		const marketData0 = velocityClient.getPerpMarketAccount(marketIndex);
		const oraclePx0 = await getFeedData(
			anchor.workspace.Pyth,
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
			'oracleTwap0:',
			marketData0.marketStats.historicalOracleData.lastOraclePriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'markTwap0:',
			marketData0.marketStats.lastMarkPriceTwap.toNumber(),
			'oracleTwapPyth:',
			oraclePx0.twap,
			'priceSpread',
			priceSpread0
		);

		const cumulativeFundingRateLongOld = marketData0.cumulativeFundingRateLong;
		const cumulativeFundingRateShortOld =
			marketData0.cumulativeFundingRateShort;

		const state = velocityClient.getStateAccount();
		assert(state.exchangeStatus === ExchangeStatus.ACTIVE);

		const market = velocityClient.getPerpMarketAccount(marketIndex);
		assert(isVariant(market.status, 'active'));

		await velocityClient.updateFundingRate(marketIndex, priceFeedAddress);

		const CONVERSION_SCALE = FUNDING_RATE_BUFFER_PRECISION.mul(PRICE_PRECISION);

		await velocityClient.fetchAccounts();
		const marketData = velocityClient.getPerpMarketAccount(marketIndex);
		const peroidicity = marketData.marketStats.fundingPeriod;

		const lastFundingRate = convertToNumber(
			marketData.lastFundingRate,
			CONVERSION_SCALE
		);

		console.log('last funding rate:', lastFundingRate);
		console.log(
			'cumfunding rate long',
			convertToNumber(marketData.cumulativeFundingRateLong, CONVERSION_SCALE),
			'cumfunding rate short',
			convertToNumber(marketData.cumulativeFundingRateShort, CONVERSION_SCALE)
		);

		const lastFundingLong = marketData.cumulativeFundingRateLong
			.sub(cumulativeFundingRateLongOld)
			.abs();
		const lastFundingShort = marketData.cumulativeFundingRateShort
			.sub(cumulativeFundingRateShortOld)
			.abs();

		assert(marketData.lastFundingRate.abs().gte(lastFundingLong.abs()));
		console.log(
			convertToNumber(marketData.lastFundingRate.abs()) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber(),
			'>=',
			convertToNumber(lastFundingShort.abs()) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);
		assert(marketData.lastFundingRate.abs().gte(lastFundingShort.abs()));

		const oraclePx = await getFeedData(
			anchor.workspace.Pyth,
			marketData.oracle
		);

		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const priceSpread =
			marketData.marketStats.lastMarkPriceTwap.toNumber() /
				PRICE_PRECISION.toNumber() -
			marketData.marketStats.historicalOracleData.lastOraclePriceTwap.toNumber() /
				PRICE_PRECISION.toNumber();
		const frontEndFundingCalc =
			priceSpread / ((24 * 3600) / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',
			frontEndFundingCalc,
			'markTwap:',
			marketData.marketStats.lastMarkPriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'oracleTwap:',
			marketData.marketStats.historicalOracleData.lastOraclePriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'markTwap:',
			marketData.marketStats.lastMarkPriceTwap.toNumber(),
			'oracleTwapPyth:',
			oraclePx.twap,
			'priceSpread:',
			priceSpread
		);
		const s = new Date(
			marketData.marketStats.lastMarkPriceTwapTs.toNumber() * 1000
		);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);

		// assert(Math.abs(frontEndFundingCalc - lastFundingRate) < 9e-6);
	}
}

async function cappedSymFundingScenario(
	rollingMarketNum: number,
	velocityClient: TestClient,
	userAccount: User,
	velocityClient2: TestClient,
	userAccount2: User,
	marketIndex: number,
	kSqrt: BN,
	priceAction: Array<number>,
	longShortSizes: Array<number>,
	fees = 0
) {
	const priceFeedAddress = await mockOracle(priceAction[0], -10);
	const periodicity = new BN(0);

	await velocityClient.initializePerpMarket(
		rollingMarketNum,
		priceFeedAddress,
		kSqrt,
		kSqrt,
		periodicity,
		new BN(priceAction[0] * PEG_PRECISION.toNumber())
	);
	await velocityClient.updatePerpMarketContractTier(
		rollingMarketNum,
		ContractTier.A
	);
	await velocityClient.accountSubscriber.addOracle({
		source: OracleSource.PYTH_LAZER,
		publicKey: priceFeedAddress,
	});
	await velocityClient2.accountSubscriber.addOracle({
		source: OracleSource.PYTH_LAZER,
		publicKey: priceFeedAddress,
	});
	await sleep(2500);

	if (fees && fees > 0) {
		await velocityClient.updateExchangeStatus(ExchangeStatus.FUNDING_PAUSED);

		console.log('spawn some fee pool');

		await velocityClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.mul(new BN(100)),
			marketIndex
		);
		await velocityClient.closePosition(marketIndex);
		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);
		await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
	}
	await velocityClient.fetchAccounts();

	const oracleData = velocityClient.getOracleDataForPerpMarket(0);
	console.log(
		'PRICE',
		convertToNumber(
			calculateReservePrice(
				velocityClient.getPerpMarketAccount(marketIndex),
				undefined
			)
		),
		'oracleData:',
		convertToNumber(oracleData.price),
		'+/-',
		convertToNumber(oracleData.confidence)
	);
	console.log(ExchangeStatus.FUNDING_PAUSED);
	console.log(ExchangeStatus.ACTIVE);

	await velocityClient.updateExchangeStatus(ExchangeStatus.FUNDING_PAUSED);
	await velocityClient.fetchAccounts();

	if (longShortSizes[0] !== 0) {
		console.log('velocityClient.openPosition');
		const txSig = await velocityClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.mul(new BN(longShortSizes[0])),
			marketIndex
		);
		await printTxLogs(velocityClient.connection, txSig);
	}

	// try{
	if (longShortSizes[1] !== 0) {
		console.log('velocityClient2.openPosition');
		await velocityClient2.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION.mul(new BN(longShortSizes[1])),
			marketIndex
		);
	}
	await sleep(1500);
	await velocityClient.fetchAccounts();
	await velocityClient2.fetchAccounts();
	await sleep(1500);

	console.log(longShortSizes[0], longShortSizes[1]);
	await userAccount.fetchAccounts();
	const uA = userAccount.getUserAccount();
	console.log(
		'userAccount.getTotalPositionValue():',
		userAccount.getTotalPerpPositionLiability().toString(),
		uA.perpPositions[0].marketIndex,
		':',
		uA.perpPositions[0].baseAssetAmount.toString(),
		'/',
		uA.perpPositions[0].quoteAssetAmount.toString()
	);
	await userAccount2.fetchAccounts();
	const uA2 = userAccount2.getUserAccount();

	console.log(
		'userAccount2.getTotalPositionValue():',
		userAccount2.getTotalPerpPositionLiability().toString(),
		uA2.perpPositions[0].marketIndex,
		':',
		uA2.perpPositions[0].baseAssetAmount.toString(),
		'/',
		uA2.perpPositions[0].quoteAssetAmount.toString()
	);

	if (longShortSizes[0] != 0) {
		assert(!userAccount.getTotalPerpPositionLiability().eq(new BN(0)));
	} else {
		assert(userAccount.getTotalPerpPositionLiability().eq(new BN(0)));
	}
	if (longShortSizes[1] != 0) {
		assert(!userAccount2.getTotalPerpPositionLiability().eq(new BN(0)));
	} else {
		assert(userAccount2.getTotalPerpPositionLiability().eq(new BN(0)));
	}

	await velocityClient.fetchAccounts();
	const market = velocityClient.getPerpMarketAccount(marketIndex);

	await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);

	console.log('priceAction update', priceAction, priceAction.slice(1));
	await updateFundingRateHelper(
		velocityClient,
		marketIndex,
		market.oracle,
		priceAction.slice(1)
	);

	await velocityClient.fetchAccounts();
	await velocityClient2.fetchAccounts();

	const marketNew = velocityClient.getPerpMarketAccount(marketIndex);

	const fundingRateLong = marketNew.cumulativeFundingRateLong; //.sub(prevFRL);
	const fundingRateShort = marketNew.cumulativeFundingRateShort; //.sub(prevFRS);

	console.log(
		'fundingRateLong',
		convertToNumber(
			fundingRateLong,
			PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
		),
		'fundingRateShort',
		convertToNumber(
			fundingRateShort,
			PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		),
		'fundingPnLForShorts',
		convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		)
	);

	// more dollars long than short
	assert(!fundingRateLong.eq(new BN(0)));
	assert(!fundingRateShort.eq(new BN(0)));

	// await velocityClient.moveAmmToPrice(
	// 	marketIndex,
	// 	new BN(priceAction[1] * PRICE_PRECISION.toNumber())
	// );

	setFeedPrice(anchor.workspace.Pyth, priceAction[0], priceFeedAddress);
	await velocityClient.updateExchangeStatus(ExchangeStatus.FUNDING_PAUSED);

	assert(fundingRateShort.lte(fundingRateLong));
	if (longShortSizes[0] !== 0) {
		await velocityClient.closePosition(marketIndex);
		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);
	}
	if (longShortSizes[1] !== 0) {
		await velocityClient2.closePosition(marketIndex);
		await velocityClient2.settlePNL(
			await velocityClient2.getUserAccountPublicKey(),
			velocityClient2.getUserAccount(),
			marketIndex
		);
	}
	await velocityClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
	setFeedPrice(anchor.workspace.Pyth, priceAction[1], priceFeedAddress);

	await sleep(2000);

	await velocityClient.fetchAccounts();
	await velocityClient2.fetchAccounts();
	await userAccount.fetchAccounts();
	await userAccount2.fetchAccounts();

	console.log(
		userAccount.getTotalPerpPositionLiability().toString(),
		',',
		userAccount2.getTotalPerpPositionLiability().toString()
	);

	assert(userAccount.getTotalPerpPositionLiability().eq(new BN(0)));
	assert(userAccount2.getTotalPerpPositionLiability().eq(new BN(0)));

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
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let velocityClient: TestClient;
	let velocityClient2: TestClient;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		PRICE_PRECISION
	);

	const usdcAmount = new BN(100000 * 10 ** 6);

	let userAccount: User;
	let userAccount2: User;

	let rollingMarketNum = 0;

	before(async () => {
		const context = await startAnchor('', [], []);

		const bankrunContextWrapper = new BankrunContextWrapper(context);

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

		const spotMarketIndexes = [0];
		const marketIndexes = Array.from({ length: 15 }, (_, i) => i);
		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			subAccountIds: [],
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.fetchAccounts();
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		await velocityClient.initializeUserAccount();
		userAccount = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userAccount.subscribe();
		await velocityClient.fetchAccounts();

		await velocityClient.fetchAccounts();

		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const [_userUSDCAccounts, _user_keys, velocityClients, userAccountInfos] =
			await initUserAccounts(
				1,
				usdcMint,
				usdcAmount,
				bankrunContextWrapper,
				marketIndexes,
				spotMarketIndexes,
				[],
				bulkAccountLoader
			);

		velocityClient2 = velocityClients[0];
		userAccount2 = userAccountInfos[0];
	});

	it('capped sym funding: ($1 long, $200 short, oracle < mark)', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;
		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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

		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 44.5],
			[50, 25],
			10000
		);

		//ensure it was clamped :)
		await velocityClient.fetchAccounts();
		const marketNew = velocityClient.getPerpMarketAccount(marketIndex);
		console.log(
			'marketNew.marketStats.historicalOracleData.lastOraclePriceTwap:',
			marketNew.marketStats.historicalOracleData.lastOraclePriceTwap.toString()
		);
		const clampedFundingRatePct = new BN(
			(0.03 * PRICE_PRECISION.toNumber()) / 24
		).mul(FUNDING_RATE_BUFFER_PRECISION);
		const clampedFundingRate = new BN(44.5 * PRICE_PRECISION.toNumber())
			.mul(FUNDING_RATE_BUFFER_PRECISION)
			.div(new BN(24))
			.div(new BN(33));
		console.log(
			'clamped funding:',
			convertToNumber(clampedFundingRate) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber(),
			'hourly pct:',
			convertToNumber(clampedFundingRatePct) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);
		console.log(
			'short funding:',
			convertToNumber(fundingRateShort) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);

		assert(fundingRateShort.abs().eq(fundingRateLong.abs()));
		console.log(fundingRateShort.abs().toString());
		console.log(clampedFundingRate.toString());

		assert(
			fundingRateShort.abs().sub(clampedFundingRate).abs().lt(new BN(1000))
		);

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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 45.1],
			[50, 25]
		);

		//ensure it was clamped :)
		await velocityClient.fetchAccounts();
		const _marketNew = velocityClient.getPerpMarketAccount(marketIndex);
		const clampedFundingRatePct = new BN(
			(0.03 * PRICE_PRECISION.toNumber()) / 24
		).mul(FUNDING_RATE_BUFFER_PRECISION);
		const clampedFundingRate = new BN(45.1 * PRICE_PRECISION.toNumber())
			.mul(FUNDING_RATE_BUFFER_PRECISION)
			.div(new BN(24))
			.div(new BN(33));
		console.log(
			'clamped funding:',
			convertToNumber(clampedFundingRate) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber(),
			'hourly pct:',
			convertToNumber(clampedFundingRatePct) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);
		console.log(
			'short funding:',
			convertToNumber(fundingRateShort) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		// assert(fundingRateShort.abs().gt(clampedFundingRate));
		assert(
			fundingRateShort.abs().sub(clampedFundingRate).abs().lt(new BN(1000))
		);
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			rollingMarketNum - 1,
			velocityClient,
			userAccount,
			velocityClient2,
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
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
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
