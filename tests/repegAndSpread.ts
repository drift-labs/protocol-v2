import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BN,
	calculatePrice,
	getMarketOrderParams,
	OracleSource,
	BID_ASK_SPREAD_PRECISION,
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	getTokenAmount,
	SpotBalanceType,
	ZERO,
	getLimitOrderParams,
	TestClient,
	OraclePriceData,
	OracleGuardRails,
	BASE_PRECISION,
	BulkAccountLoader,
	PERCENTAGE_PRECISION,
	ContractTier,
} from '../sdk';
import { Keypair } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';

import {
	User,
	// PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	// calculateReservePrice,
	PositionDirection,
	EventSubscriber,
	convertToNumber,
	calculateBidAskPrice,
	calculateUpdatedAMM,
	calculateSpread,
	calculateSpreadBN,
	calculateInventoryScale,
	calculateEffectiveLeverage,
	calculateLiveOracleStd,
} from '../sdk/src';

import {
	getFeedData,
	initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	getOraclePriceData,
	initializeQuoteSpotMarket,
} from './testHelpers';

async function depositToFeePoolFromIF(
	amount: number,
	driftClient: TestClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	try {
		const txSig00 = await driftClient.depositIntoPerpMarketFeePool(
			0,
			ifAmount,
			userUSDCAccount.publicKey
		);
		console.log('complete withdrawFromInsuranceVaultToMarket:', '$', amount);

		console.log(txSig00);
	} catch (e) {
		console.error(e);
	}
}

async function iterClosePosition(
	driftClient: TestClient,
	marketIndex: number,
	oraclePriceData: OraclePriceData
) {
	let userPosition = driftClient.getUser().getPerpPosition(marketIndex);
	let posDirection;
	let limitPrice: BN;

	if (userPosition.baseAssetAmount.lt(ZERO)) {
		posDirection = PositionDirection.LONG;
		limitPrice = oraclePriceData.price.mul(new BN(10248)).div(new BN(10000));
		console.log(
			'iterClosePosition:: close position limit: ',
			convertToNumber(limitPrice)
		);
		assert(limitPrice.gt(oraclePriceData.price));
	} else {
		posDirection = PositionDirection.SHORT;
		limitPrice = oraclePriceData.price.mul(new BN(10000)).div(new BN(10248));
		console.log(
			'iterClosePosition:: close position limit: ',
			convertToNumber(limitPrice)
		);
		assert(limitPrice.lt(oraclePriceData.price));
	}

	while (!userPosition.baseAssetAmount.eq(ZERO)) {
		const closeOrderParams = getLimitOrderParams({
			marketIndex,
			direction: posDirection,
			baseAssetAmount: userPosition.baseAssetAmount.abs(),
			reduceOnly: true,
			price: limitPrice,
			immediateOrCancel: true,
		});
		const txClose = await driftClient.placeAndTakePerpOrder(closeOrderParams);
		console.log(
			'tx logs',
			(
				await driftClient.connection.getTransaction(txClose, {
					commitment: 'confirmed',
				})
			).meta.logMessages
		);
		await driftClient.fetchAccounts();
		userPosition = driftClient.getUser().getPerpPosition(marketIndex);
		console.log(
			'userPosition.baseAssetAmount: ',
			userPosition.baseAssetAmount.toString()
		);
	}
}

describe('repeg and spread amm', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	// let userAccountPublicKey: PublicKeys;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	// const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(94).mul(
		AMM_RESERVE_PRECISION
	);
	const ammInitialBaseAssetAmount = new anchor.BN(94).mul(
		AMM_RESERVE_PRECISION
	);

	const usdcAmount = new BN(10000 * 10 ** 6);

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;
	let btcUsd;
	const mockOracles = [];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)),
			provider
		);

		btcUsd = await mockOracle(21966.86);
		mockOracles.push(btcUsd);
		for (let i = 1; i <= 4; i++) {
			// init more oracles
			const thisUsd = await mockOracle(i);
			mockOracles.push(thisUsd);
		}

		spotMarketIndexes = [0];
		marketIndexes = mockOracles.map((_, i) => i);
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos: oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await driftClient.updatePerpAuctionDuration(0);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		// BTC
		await driftClient.initializePerpMarket(
			0,
			btcUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(21966.868 * PEG_PRECISION.toNumber()),
			undefined,
			ContractTier.A,
			500,
			250,
			undefined,
			undefined,
			undefined,
			true,
			250,
			400
		);
		await driftClient.updatePerpMarketBaseSpread(0, 250);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		// for (let i = 1; i <= 4; i++) {
		// 	// init more markets
		// 	const thisUsd = mockOracles[i];
		// 	await driftClient.initializeMarket(
		// 		thisUsd,
		// 		ammInitialBaseAssetAmount,
		// 		ammInitialQuoteAssetAmount,
		// 		periodicity,
		// 		new BN(1_000 * i),
		// 		undefined,
		// 		1000,
		// 		201
		// 	);
		// 	await driftClient.updatePerpMarketBaseSpread(new BN(i), 2000);
		// 	await driftClient.updatePerpMarketCurveUpdateIntensity(new BN(i), 100);
		// }

		const [, _userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('BTC market massive spread', async () => {
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION,
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION,
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(2),
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		await driftClient.fetchAccounts();
		const state = driftClient.getStateAccount();

		assert(
			JSON.stringify(oracleGuardRails) ===
				JSON.stringify(state.oracleGuardRails)
		);

		const marketIndex = 0;
		const baseAssetAmount = new BN(0.19316 * AMM_RESERVE_PRECISION.toNumber());
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();

		await depositToFeePoolFromIF(0.001, driftClient, userUSDCAccount);

		// await driftClient.closePosition(new BN(0));
		const txSig0 = await driftClient.placeAndTakePerpOrder(orderParams);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig0, { commitment: 'confirmed' }))
				.meta.logMessages
		);
		await depositToFeePoolFromIF(50, driftClient, userUSDCAccount);

		await driftClient.fetchAccounts();
		const btcPerpAccount = driftClient.getPerpMarketAccount(0);
		assert(btcPerpAccount.numberOfUsersWithBase == 1);
		assert(btcPerpAccount.numberOfUsers == 1);
		assert(btcPerpAccount.amm.baseAssetAmountWithAmm.lt(ZERO));
		console.log(
			btcPerpAccount.amm.baseAssetAmountWithAmm.toString(),
			baseAssetAmount.toString()
		);
		assert(btcPerpAccount.amm.baseAssetAmountWithAmm.eq(new BN('-193100000')));
		assert(btcPerpAccount.amm.shortIntensityVolume.gt(ZERO));
		assert(btcPerpAccount.amm.longIntensityVolume.eq(ZERO));
		assert(btcPerpAccount.amm.markStd.gt(ZERO));
		assert(btcPerpAccount.amm.oracleStd.gt(ZERO));

		// old oracle price: 21966
		await setFeedPrice(anchor.workspace.Pyth, 19790, btcUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, btcUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			btcUsd
		);
		const market0 = driftClient.getPerpMarketAccount(0);
		console.log(
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toNumber() /
				QUOTE_PRECISION.toNumber()
		);
		console.log(
			'market0.amm.pegMultiplier:',
			market0.amm.pegMultiplier.toNumber() / PEG_PRECISION.toNumber()
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);

		console.log(
			'market0.amm.netBaseAssetAmount:',
			market0.amm.baseAssetAmountWithAmm.toString(),
			'terminalQuoteAssetReserve:',
			market0.amm.terminalQuoteAssetReserve.toString(),
			'quoteAssetReserve:',
			market0.amm.quoteAssetReserve.toString(),
			'pegMultiplier:',
			market0.amm.pegMultiplier.toString(),
			'->',
			prepegAMM.pegMultiplier.toString()
		);

		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
		const [longSpread, shortSpread] = calculateSpread(
			market0.amm,
			oraclePriceData
		);

		const [bid2, ask2] = calculateBidAskPrice(
			prepegAMM,
			oraclePriceData,
			false
		);
		const [longSpread2, shortSpread2] = calculateSpread(
			prepegAMM,
			oraclePriceData
		);

		const reservePrice = calculatePrice(
			prepegAMM.baseAssetReserve,
			prepegAMM.quoteAssetReserve,
			prepegAMM.pegMultiplier
		);
		console.log('maxSpread:', prepegAMM.maxSpread);

		console.log('bid/ask:', convertToNumber(bid), convertToNumber(ask));
		console.log('spreads:', longSpread, shortSpread);

		console.log(
			'bid2/reserve/ask2:',
			convertToNumber(bid2),
			convertToNumber(reservePrice),
			convertToNumber(ask2)
		);
		console.log('spreads:', longSpread2, shortSpread2);

		assert(shortSpread2 > longSpread2);

		const targetPrice = oraclePriceData?.price || reservePrice;

		const targetMarkSpreadPct = reservePrice
			.sub(targetPrice)
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(reservePrice);

		const tfMD =
			prepegAMM.totalFeeMinusDistributions.toNumber() /
			QUOTE_PRECISION.toNumber();
		console.log('prepegAMM.totalFeeMinusDistributions:', tfMD);
		assert(tfMD < 0); // enforcing max spread

		console.log(
			'prepegAMM.pegMultiplier:',
			prepegAMM.pegMultiplier.toNumber() / PEG_PRECISION.toNumber()
		);
		358332628 / 358340434;
		console.log(
			'prepegAMM.netBaseAssetAmount:',
			prepegAMM.baseAssetAmountWithAmm.toString(),
			'terminalQuoteAssetReserve:',
			prepegAMM.terminalQuoteAssetReserve.toString(),
			'quoteAssetReserve:',
			prepegAMM.quoteAssetReserve.toString(),
			'pegMultiplier:',
			prepegAMM.pegMultiplier.toString()
		);

		const now = new BN(new Date().getTime() / 1000); //todo
		const liveOracleStd = calculateLiveOracleStd(
			prepegAMM,
			oraclePriceData,
			now
		);

		const [ls1, ss1] = calculateSpreadBN(
			prepegAMM.baseSpread,
			targetMarkSpreadPct,
			new BN(0),
			prepegAMM.maxSpread,
			prepegAMM.quoteAssetReserve,
			prepegAMM.terminalQuoteAssetReserve,
			prepegAMM.pegMultiplier,
			prepegAMM.baseAssetAmountWithAmm,
			reservePrice,
			prepegAMM.totalFeeMinusDistributions,
			prepegAMM.netRevenueSinceLastFunding,
			prepegAMM.baseAssetReserve,
			prepegAMM.minBaseAssetReserve,
			prepegAMM.maxBaseAssetReserve,
			prepegAMM.markStd,
			liveOracleStd,
			prepegAMM.longIntensityVolume,
			prepegAMM.shortIntensityVolume,
			prepegAMM.volume24H
		);
		console.log('spreads:', ls1, ss1);
		const maxSpread = market0.amm.maxSpread;
		assert(ls1 + ss1 == maxSpread);

		console.log(
			'pre trade bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'\n pre trade mark price:',
			convertToNumber(
				calculatePrice(
					prepegAMM.baseAssetReserve,
					prepegAMM.quoteAssetReserve,
					prepegAMM.pegMultiplier
				)
			),
			'peg:',
			prepegAMM.pegMultiplier.toString(),
			'tfmq:',
			prepegAMM.totalFeeMinusDistributions.toString()
		);

		const midPrice = (convertToNumber(bid) + convertToNumber(ask)) / 2;

		console.log(convertToNumber(oraclePriceData.price), midPrice);
		console.log(
			'getSpotMarketAssetValue:',
			driftClientUser.getSpotMarketAssetValue().toString()
		);

		const effectiveLeverage = calculateEffectiveLeverage(
			prepegAMM.baseSpread,
			prepegAMM.quoteAssetReserve,
			prepegAMM.terminalQuoteAssetReserve,
			prepegAMM.pegMultiplier,
			prepegAMM.baseAssetAmountWithAmm,
			reservePrice,
			prepegAMM.totalFeeMinusDistributions
		);
		const inventoryScale = calculateInventoryScale(
			prepegAMM.baseAssetAmountWithAmm,
			prepegAMM.baseAssetReserve,
			prepegAMM.minBaseAssetReserve,
			prepegAMM.maxBaseAssetReserve,
			prepegAMM.baseSpread,
			prepegAMM.maxSpread
		);

		console.log('inventoryScale:', inventoryScale);
		console.log('effectiveLeverage:', effectiveLeverage);
		assert(Math.min(effectiveLeverage, 10) == 10); // lol
		assert(Math.min(inventoryScale, 10) >= 1.66386);
		assert(Math.min(inventoryScale, 10) <= 1.66387);

		try {
			const txSig = await driftClient.updateAMMs([marketIndex]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const market = driftClient.getPerpMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(
			market.amm,
			oraclePriceData,
			false
		);

		console.log(
			'longSpread/shortSpread:',
			market.amm.longSpread,
			market.amm.shortSpread
		);

		const mark1 = calculatePrice(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);
		console.log(
			'post trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'\n post trade mark price:',
			convertToNumber(mark1),
			'peg:',
			market.amm.pegMultiplier.toString(),
			'tfmq:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		assert(bid1.sub(bid).abs().lte(new BN(100))); // minor sdk/contract rounding diff on adj k cost
		assert(ask1.sub(ask).abs().lte(new BN(100))); // minor sdk/contract rounding diff on adj k cost
		assert(mark1.sub(reservePrice).abs().lte(new BN(100)));
		console.log(market.amm.pegMultiplier.toString());
		console.log(oraclePriceData.price.toString());

		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		const actualDist = market.amm.totalFee.sub(
			market.amm.totalFeeMinusDistributions
		);
		console.log('actual distribution:', actualDist.toString());

		console.log(prepegAMM.sqrtK.toString(), '==', market.amm.sqrtK.toString());
		const marketInvariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		// check k math good
		const qAR1 = marketInvariant.div(market.amm.baseAssetReserve);
		const bAR1 = marketInvariant.div(market.amm.quoteAssetReserve);
		console.log(qAR1.toString(), '==', market.amm.quoteAssetReserve.toString());
		assert(qAR1.eq(market.amm.quoteAssetReserve));
		console.log(bAR1.toString(), '==', market.amm.baseAssetReserve.toString());
		assert(bAR1.eq(market.amm.baseAssetReserve));

		await driftClient.fetchAccounts();
		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		console.log(
			driftClient.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(
					new BN(-0.1931 * BASE_PRECISION.toNumber())
				)
		);
		// assert(
		// 	driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString() ==
		// 		'4229493402'
		// ); // $4229.49

		let userPosition = driftClient.getUser().getPerpPosition(marketIndex);

		assert(market.amm.maxSlippageRatio == 50);
		const limitPrice = oraclePriceData.price
			.mul(new BN(10248))
			.div(new BN(10000));
		console.log('close position limit: ', convertToNumber(limitPrice));
		assert(limitPrice.gt(oraclePriceData.price));

		while (!userPosition.baseAssetAmount.eq(ZERO)) {
			const closeOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount: userPosition.baseAssetAmount.abs(),
				reduceOnly: true,
				price: limitPrice,
				immediateOrCancel: true,
			});
			const txClose = await driftClient.placeAndTakePerpOrder(closeOrderParams);
			console.log(
				'tx logs',
				(await connection.getTransaction(txClose, { commitment: 'confirmed' }))
					.meta.logMessages
			);
			await driftClient.fetchAccounts();
			userPosition = driftClient.getUser().getPerpPosition(marketIndex);
			console.log(
				'userPosition.baseAssetAmount: ',
				userPosition.baseAssetAmount.toString()
			);
		}

		console.log(
			driftClient.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString() == '0'
		);
		// assert(
		// 	driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString() ==
		// 		'203455312'
		// ); // $203.45

		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString() == '0'
		);

		console.log(
			'getSpotMarketAssetValue:',
			driftClientUser.getSpotMarketAssetValue().toString()
		);
		const spotMarketAccount0 = driftClient.getSpotMarketAccount(0);

		const feePoolBalance0 = getTokenAmount(
			market.amm.feePool.scaledBalance,
			spotMarketAccount0,
			SpotBalanceType.DEPOSIT
		);

		const pnlPoolBalance0 = getTokenAmount(
			market.pnlPool.scaledBalance,
			spotMarketAccount0,
			SpotBalanceType.DEPOSIT
		);

		console.log('usdcAmount:', usdcAmount.toString());
		console.log(
			'getSpotMarketAssetValue:',
			driftClientUser.getSpotMarketAssetValue().toString()
		);
		console.log('feePoolBalance0:', feePoolBalance0.toString());
		console.log('pnlPoolBalance0:', pnlPoolBalance0.toString());

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await driftClient.fetchAccounts();
		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		console.log(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		// assert(
		// 	driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString() ==
		// 		'157582183'
		// ); // $157.58
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString() == '0'
		);

		await depositToFeePoolFromIF(157.476328, driftClient, userUSDCAccount);

		const market1 = driftClient.getPerpMarketAccount(0);
		console.log(
			'after fee pool deposit totalFeeMinusDistributions:',
			market1.amm.totalFeeMinusDistributions.toString()
		);

		assert(!market1.amm.totalFeeMinusDistributions.eq(ZERO));

		const spotMarketAccount = driftClient.getSpotMarketAccount(0);

		const revPoolBalance = getTokenAmount(
			spotMarketAccount.revenuePool.scaledBalance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);

		const feePoolBalance = getTokenAmount(
			market1.amm.feePool.scaledBalance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);

		const pnlPoolBalance = getTokenAmount(
			market1.pnlPool.scaledBalance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);

		console.log('usdcAmount:', usdcAmount.toString());
		console.log(
			'getSpotMarketAssetValue:',
			driftClientUser.getSpotMarketAssetValue().toString()
		);
		console.log('revPoolBalance:', revPoolBalance.toString());
		console.log('feePoolBalance:', feePoolBalance.toString());
		console.log('pnlPoolBalance:', pnlPoolBalance.toString());

		// assert(driftClientUser.getSpotMarketAssetValue().eq(new BN('10000000000'))); // remainder is of debt is for fees for revenue pool
		await driftClientUser.unsubscribe();
	});

	it('5 users, 15 trades, single market, user net win, check invariants', async () => {
		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const driftClientOld = driftClient;

		const [_userUSDCAccounts, _user_keys, driftClients, _userAccountInfos] =
			await initUserAccounts(
				5,
				usdcMint,
				usdcAmount,
				provider,
				marketIndexes,
				spotMarketIndexes,
				[],
				bulkAccountLoader
			);
		let count = 0;
		let btcPrice = 19790;
		while (count < 15) {
			console.log(count);

			if (count % 3 == 0) {
				btcPrice *= 1.075;
				// btcPrice *= 1.001;
			} else {
				btcPrice *= 0.999;
				// btcPrice *= 0.925;
			}
			await setFeedPrice(anchor.workspace.Pyth, btcPrice, btcUsd);
			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				btcUsd
			);

			const market0 = driftClient.getPerpMarketAccount(0);
			const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
			const [longSpread, shortSpread] = calculateSpread(
				prepegAMM,
				oraclePriceData
			);
			console.log('spreads:', longSpread, shortSpread);
			console.log(
				'bid/oracle/ask:',
				convertToNumber(bid),
				btcPrice,
				convertToNumber(ask)
			);
			let tradeSize =
				0.053 * ((count % 7) + 1) * AMM_RESERVE_PRECISION.toNumber();
			let tradeDirection;
			if (count % 2 == 0) {
				tradeDirection = PositionDirection.LONG;
				tradeSize *= 2;
			} else {
				tradeDirection = PositionDirection.SHORT;
			}

			const orderParams = getMarketOrderParams({
				marketIndex: 0,
				direction: tradeDirection,
				baseAssetAmount: new BN(tradeSize),
			});

			await driftClients[count % 5].placeAndTakePerpOrder(orderParams);
			count += 1;
		}

		let allUserCollateral = 0;
		let allUserUnsettledPnl = 0;

		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userCollateral = convertToNumber(
			driftClientUser.getSpotMarketAssetValue(),
			QUOTE_PRECISION
		);

		const userUnsettledPnl = convertToNumber(
			driftClientUser
				.getUserAccount()
				.perpPositions.reduce((unsettledPnl, position) => {
					return unsettledPnl.add(
						position.quoteAssetAmount.add(position.quoteBreakEvenAmount)
					);
				}, ZERO),
			QUOTE_PRECISION
		);
		console.log('unsettle pnl', userUnsettledPnl);
		allUserCollateral += userCollateral;
		allUserUnsettledPnl += userUnsettledPnl;
		console.log(
			'user',
			0,
			':',
			'$',
			userCollateral,
			'+',
			userUnsettledPnl,
			'(unsettled)'
		);
		await driftClientUser.unsubscribe();

		const oraclePriceData1 = await getOraclePriceData(
			anchor.workspace.Pyth,
			btcUsd
		);

		for (let i = 0; i < driftClients.length; i++) {
			const pos = driftClients[i].getUserAccount().perpPositions[0];
			console.log(
				'user',
				i,
				'pos.baseAssetAmount:',
				pos.baseAssetAmount.toString()
			);
			if (!pos.baseAssetAmount.eq(ZERO)) {
				// await driftClients[i].closePosition(new BN(0));
				await iterClosePosition(driftClients[i], 0, oraclePriceData1);
				await driftClients[i].settlePNL(
					await driftClients[i].getUserAccountPublicKey(),
					driftClients[i].getUserAccount(),
					0
				);
				await driftClients[i].fetchAccounts();
			}

			const driftClientI = driftClients[i];
			const driftClientUserI = _userAccountInfos[i];
			const userCollateral = convertToNumber(
				driftClientUserI.getSpotMarketAssetValue(),
				QUOTE_PRECISION
			);
			await driftClientI.fetchAccounts();
			await driftClientUserI.fetchAccounts();

			const unsettledPnl = driftClientUserI
				.getUserAccount()
				.perpPositions.reduce((unsettledPnl, position) => {
					return unsettledPnl.add(
						position.quoteAssetAmount.add(position.quoteEntryAmount)
					);
				}, ZERO);
			console.log('unsettled pnl', unsettledPnl.toString());
			const userUnsettledPnl = convertToNumber(unsettledPnl, QUOTE_PRECISION);
			allUserCollateral += userCollateral;
			allUserUnsettledPnl += userUnsettledPnl;
			console.log(
				'user',
				i + 1,
				':',
				'$',
				userCollateral,
				'+',
				userUnsettledPnl,
				'(unsettled)'
			);
			await driftClientI.unsubscribe();
			await driftClientUserI.unsubscribe();
		}

		const market0 = driftClientOld.getPerpMarketAccount(0);

		console.log('total Fees:', market0.amm.totalFee.toString());
		console.log(
			'total Fees minus dist:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const spotMarketAccount = driftClientOld.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const revPoolBalance = convertToNumber(
			getTokenAmount(
				spotMarketAccount.revenuePool.scaledBalance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const pnlPoolBalance = convertToNumber(
			getTokenAmount(
				market0.pnlPool.scaledBalance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const feePoolBalance = convertToNumber(
			getTokenAmount(
				market0.amm.feePool.scaledBalance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const usdcDepositBalance = convertToNumber(
			getTokenAmount(
				spotMarketAccount.depositBalance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const usdcBorrowBalance = convertToNumber(
			getTokenAmount(
				spotMarketAccount.borrowBalance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		console.log(
			'usdc balance:',
			usdcDepositBalance.toString(),
			'-',
			usdcBorrowBalance.toString()
		);

		const sinceStartTFMD = convertToNumber(
			market0.amm.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);

		console.log(allUserCollateral.toString());

		console.log(
			'sum all money:',
			allUserCollateral,
			'+',
			pnlPoolBalance,
			'+',
			feePoolBalance,
			'+',
			revPoolBalance,
			'+',
			allUserUnsettledPnl,
			'+',
			sinceStartTFMD,
			'==',
			usdcDepositBalance - usdcBorrowBalance
		);

		// assert(allUserCollateral == 60207.477328); // old way for fee -> pnl pool
		// assert(allUserCollateral == 60115.507665);
		// assert(pnlPoolBalance == 0);
		// assert(feePoolBalance == 91.969663);
		// assert(allUserUnsettledPnl == 673.8094719999999);
		// assert(usdcDepositBalance == 60207.477328);
		// assert(sinceStartTFMD == -583.629353);

		const moneyMissing = Math.abs(
			allUserCollateral +
				pnlPoolBalance +
				feePoolBalance -
				(usdcDepositBalance - usdcBorrowBalance)
		);
		console.log('moneyMissing:', moneyMissing);

		assert(moneyMissing < 1e-7);

		console.log(
			'market0.amm.netBaseAssetAmount:',
			market0.amm.baseAssetAmountWithAmm.toString()
		);
		assert(market0.amm.baseAssetAmountWithAmm.eq(new BN(0)));

		// console.log(market0);

		// todo: doesnt add up perfectly (~$2 off), adjust peg/k not precise?
		// must be less
		assert(
			allUserUnsettledPnl +
				(sinceStartTFMD - (pnlPoolBalance + feePoolBalance)) <
				0
		);
	});
});
