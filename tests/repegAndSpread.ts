import * as anchor from '@project-serum/anchor';
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
	ClearingHouse,
	OraclePriceData,
	OracleGuardRails,
	BASE_PRECISION,
} from '../sdk';
import { Keypair } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';

import {
	Admin,
	ClearingHouseUser,
	// MARK_PRICE_PRECISION,
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
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());

	// // send $50 to market from IF
	try {
		const txSig00 = await clearingHouse.depositIntoMarketFeePool(
			new BN(0),
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
	clearingHouse: ClearingHouse,
	marketIndex: BN,
	oraclePriceData: OraclePriceData
) {
	let userPosition = clearingHouse.getUser().getUserPosition(marketIndex);
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
		const txClose = await clearingHouse.placeAndTake(closeOrderParams);
		console.log(
			'tx logs',
			(
				await clearingHouse.connection.getTransaction(txClose, {
					commitment: 'confirmed',
				})
			).meta.logMessages
		);
		await clearingHouse.fetchAccounts();
		userPosition = clearingHouse.getUser().getUserPosition(marketIndex);
		console.log(
			'userPosition.baseAssetAmount: ',
			userPosition.baseAssetAmount.toString()
		);
	}
}

describe('repeg and spread amm', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	// let userAccountPublicKey: PublicKeys;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	// const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
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

		spotMarketIndexes = [new BN(0)];
		marketIndexes = mockOracles.map((_, i) => new BN(i));
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos: oracleInfos,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.updatePerpAuctionDuration(0);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		// BTC
		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(21966.868 * PEG_PRECISION.toNumber()),
			undefined,
			500,
			250
		);
		await clearingHouse.updateMarketBaseSpread(new BN(0), 250);
		await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

		// for (let i = 1; i <= 4; i++) {
		// 	// init more markets
		// 	const thisUsd = mockOracles[i];
		// 	await clearingHouse.initializeMarket(
		// 		thisUsd,
		// 		ammInitialBaseAssetAmount,
		// 		ammInitialQuoteAssetAmount,
		// 		periodicity,
		// 		new BN(1_000 * i),
		// 		undefined,
		// 		1000,
		// 		201
		// 	);
		// 	await clearingHouse.updateMarketBaseSpread(new BN(i), 2000);
		// 	await clearingHouse.updateCurveUpdateIntensity(new BN(i), 100);
		// }

		const [, _userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('BTC market massive spread', async () => {
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(2),
			},
			useForLiquidations: false,
		};

		await clearingHouse.updateOracleGuardRails(oracleGuardRails);

		await clearingHouse.fetchAccounts();
		const state = clearingHouse.getStateAccount();

		assert(
			JSON.stringify(oracleGuardRails) ===
				JSON.stringify(state.oracleGuardRails)
		);

		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(0.19316 * AMM_RESERVE_PRECISION.toNumber());
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		await depositToFeePoolFromIF(0.001, clearingHouse, userUSDCAccount);

		// await clearingHouse.placeAndFillOrder(orderParams);
		// await clearingHouse.closePosition(new BN(0));
		const txSig0 = await clearingHouse.placeAndTake(orderParams);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig0, { commitment: 'confirmed' }))
				.meta.logMessages
		);
		await depositToFeePoolFromIF(50, clearingHouse, userUSDCAccount);

		// old oracle price: 21966
		await setFeedPrice(anchor.workspace.Pyth, 19790, btcUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, btcUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			btcUsd
		);
		const market0 = clearingHouse.getPerpMarketAccount(0);
		console.log(
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toNumber() /
				QUOTE_PRECISION.toNumber()
		);
		console.log(
			'market0.amm.pegMultiplier:',
			market0.amm.pegMultiplier.toNumber() / PEG_PRECISION.toNumber()
		);
		console.log(
			'market0.amm.netBaseAssetAmount:',
			market0.amm.netBaseAssetAmount.toString(),
			'terminalQuoteAssetReserve:',
			market0.amm.terminalQuoteAssetReserve.toString(),
			'quoteAssetReserve:',
			market0.amm.quoteAssetReserve.toString(),
			'pegMultiplier:',
			market0.amm.pegMultiplier.toString()
		);

		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
		const longSpread = calculateSpread(
			prepegAMM,
			PositionDirection.LONG,
			oraclePriceData
		);
		const shortSpread = calculateSpread(
			prepegAMM,
			PositionDirection.SHORT,
			oraclePriceData
		);
		console.log('spreads:', longSpread, shortSpread);
		assert(shortSpread > longSpread);

		const markPrice = calculatePrice(
			prepegAMM.baseAssetReserve,
			prepegAMM.quoteAssetReserve,
			prepegAMM.pegMultiplier
		);

		const targetPrice = oraclePriceData?.price || markPrice;

		const targetMarkSpreadPct = markPrice
			.sub(targetPrice)
			.mul(BID_ASK_SPREAD_PRECISION)
			.div(markPrice);

		const tfMD =
			prepegAMM.totalFeeMinusDistributions.toNumber() /
			QUOTE_PRECISION.toNumber();
		console.log('prepegAMM.totalFeeMinusDistributions:', tfMD);
		assert(tfMD < 0); // enforcing max spread

		console.log(
			'prepegAMM.pegMultiplier:',
			prepegAMM.pegMultiplier.toNumber() / PEG_PRECISION.toNumber()
		);

		console.log(
			'prepegAMM.netBaseAssetAmount:',
			prepegAMM.netBaseAssetAmount.toString(),
			'terminalQuoteAssetReserve:',
			prepegAMM.terminalQuoteAssetReserve.toString(),
			'quoteAssetReserve:',
			prepegAMM.quoteAssetReserve.toString(),
			'pegMultiplier:',
			prepegAMM.pegMultiplier.toString()
		);
		const [ls1, ss1] = calculateSpreadBN(
			prepegAMM.baseSpread,
			targetMarkSpreadPct,
			new BN(0),
			prepegAMM.maxSpread,
			prepegAMM.quoteAssetReserve,
			prepegAMM.terminalQuoteAssetReserve,
			prepegAMM.pegMultiplier,
			prepegAMM.netBaseAssetAmount,
			markPrice,
			prepegAMM.totalFeeMinusDistributions,
			prepegAMM.baseAssetReserve,
			prepegAMM.minBaseAssetReserve,
			prepegAMM.maxBaseAssetReserve
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
			)
		);

		const midPrice = (convertToNumber(bid) + convertToNumber(ask)) / 2;

		console.log(convertToNumber(oraclePriceData.price), midPrice);
		console.log(
			'getSpotMarketAssetValue:',
			clearingHouseUser.getSpotMarketAssetValue().toString()
		);

		const effectiveLeverage = calculateEffectiveLeverage(
			prepegAMM.baseSpread,
			prepegAMM.quoteAssetReserve,
			prepegAMM.terminalQuoteAssetReserve,
			prepegAMM.pegMultiplier,
			prepegAMM.netBaseAssetAmount,
			markPrice,
			prepegAMM.totalFeeMinusDistributions
		);
		const inventoryScale = calculateInventoryScale(
			prepegAMM.netBaseAssetAmount,
			prepegAMM.baseAssetReserve,
			prepegAMM.minBaseAssetReserve,
			prepegAMM.maxBaseAssetReserve
		);

		console.log('inventoryScale:', inventoryScale);
		console.log('effectiveLeverage:', effectiveLeverage);
		assert(Math.min(effectiveLeverage, 5) == 5); // lol
		assert(inventoryScale == 0.034835);

		try {
			const txSig = await clearingHouse.updateAMMs([marketIndex]);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const market = clearingHouse.getPerpMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(
			market.amm,
			oraclePriceData,
			false
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
			convertToNumber(mark1)
		);

		assert(bid1.eq(bid));
		assert(ask1.eq(ask));
		assert(mark1.eq(markPrice));

		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		console.log(market.amm.pegMultiplier.toString());
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

		await clearingHouse.fetchAccounts();
		console.log(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.toString()
		);
		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(
					new BN(-0.19316 * BASE_PRECISION.toNumber())
				)
		);
		// assert(
		// 	clearingHouse.getUserAccount().perpPositions[0].quoteAssetAmount.toString() ==
		// 		'4229493402'
		// ); // $4229.49

		let userPosition = clearingHouse.getUser().getUserPosition(marketIndex);

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
			const txClose = await clearingHouse.placeAndTake(closeOrderParams);
			console.log(
				'tx logs',
				(await connection.getTransaction(txClose, { commitment: 'confirmed' }))
					.meta.logMessages
			);
			await clearingHouse.fetchAccounts();
			userPosition = clearingHouse.getUser().getUserPosition(marketIndex);
			console.log(
				'userPosition.baseAssetAmount: ',
				userPosition.baseAssetAmount.toString()
			);
		}

		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		console.log(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString() == '0'
		);
		// assert(
		// 	clearingHouse.getUserAccount().perpPositions[0].quoteAssetAmount.toString() ==
		// 		'203455312'
		// ); // $203.45

		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.toString() == '0'
		);

		console.log(
			'getSpotMarketAssetValue:',
			clearingHouseUser.getSpotMarketAssetValue().toString()
		);
		const spotMarketAccount0 = clearingHouse.getSpotMarketAccount(0);

		const feePoolBalance0 = getTokenAmount(
			market.amm.feePool.balance,
			spotMarketAccount0,
			SpotBalanceType.DEPOSIT
		);

		const pnlPoolBalance0 = getTokenAmount(
			market.pnlPool.balance,
			spotMarketAccount0,
			SpotBalanceType.DEPOSIT
		);

		console.log('usdcAmount:', usdcAmount.toString());
		console.log(
			'getSpotMarketAssetValue:',
			clearingHouseUser.getSpotMarketAssetValue().toString()
		);
		console.log('feePoolBalance0:', feePoolBalance0.toString());
		console.log('pnlPoolBalance0:', pnlPoolBalance0.toString());

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await clearingHouse.fetchAccounts();
		console.log(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.toString()
		);
		console.log(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.toString()
		);
		// assert(
		// 	clearingHouse.getUserAccount().perpPositions[0].quoteAssetAmount.toString() ==
		// 		'157582183'
		// ); // $157.58
		assert(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.toString() == '0'
		);

		await depositToFeePoolFromIF(157.476328, clearingHouse, userUSDCAccount);

		const market1 = clearingHouse.getPerpMarketAccount(0);
		console.log(
			'after fee pool deposit totalFeeMinusDistributions:',
			market1.amm.totalFeeMinusDistributions.toString()
		);

		assert(!market1.amm.totalFeeMinusDistributions.eq(ZERO));

		const spotMarketAccount = clearingHouse.getSpotMarketAccount(0);

		const revPoolBalance = getTokenAmount(
			spotMarketAccount.revenuePool.balance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);

		const feePoolBalance = getTokenAmount(
			market1.amm.feePool.balance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);

		const pnlPoolBalance = getTokenAmount(
			market1.pnlPool.balance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);

		console.log('usdcAmount:', usdcAmount.toString());
		console.log(
			'getSpotMarketAssetValue:',
			clearingHouseUser.getSpotMarketAssetValue().toString()
		);
		console.log('revPoolBalance:', revPoolBalance.toString());
		console.log('feePoolBalance:', feePoolBalance.toString());
		console.log('pnlPoolBalance:', pnlPoolBalance.toString());

		// assert(clearingHouseUser.getSpotMarketAssetValue().eq(new BN('10000000000'))); // remainder is of debt is for fees for revenue pool
		await clearingHouseUser.unsubscribe();
	});

	it('5 users, 15 trades, single market, user net win, check invariants', async () => {
		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const clearingHouseOld = clearingHouse;

		const [_userUSDCAccounts, _user_keys, clearingHouses, _userAccountInfos] =
			await initUserAccounts(
				5,
				usdcMint,
				usdcAmount,
				provider,
				marketIndexes,
				spotMarketIndexes,
				[]
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

			const market0 = clearingHouse.getPerpMarketAccount(0);
			const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
			const longSpread = calculateSpread(
				prepegAMM,
				PositionDirection.LONG,
				oraclePriceData
			);
			const shortSpread = calculateSpread(
				prepegAMM,
				PositionDirection.SHORT,
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
				marketIndex: new BN(0),
				direction: tradeDirection,
				baseAssetAmount: new BN(tradeSize),
			});

			await clearingHouses[count % 5].placeAndTake(orderParams);
			count += 1;
		}

		let allUserCollateral = 0;
		let allUserUnsettledPnl = 0;

		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();
		const userCollateral = convertToNumber(
			clearingHouseUser.getSpotMarketAssetValue(),
			QUOTE_PRECISION
		);

		const userUnsettledPnl = convertToNumber(
			clearingHouseUser
				.getUserAccount()
				.perpPositions.reduce((unsettledPnl, position) => {
					return unsettledPnl.add(
						position.quoteAssetAmount.add(position.quoteEntryAmount)
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
		await clearingHouseUser.unsubscribe();

		const oraclePriceData1 = await getOraclePriceData(
			anchor.workspace.Pyth,
			btcUsd
		);

		for (let i = 0; i < clearingHouses.length; i++) {
			const pos = clearingHouses[i].getUserAccount().perpPositions[0];
			console.log(
				'user',
				i,
				'pos.baseAssetAmount:',
				pos.baseAssetAmount.toString()
			);
			if (!pos.baseAssetAmount.eq(ZERO)) {
				// await clearingHouses[i].closePosition(new BN(0));
				await iterClosePosition(clearingHouses[i], new BN(0), oraclePriceData1);
				await clearingHouses[i].settlePNL(
					await clearingHouses[i].getUserAccountPublicKey(),
					clearingHouses[i].getUserAccount(),
					new BN(0)
				);
			}

			const clearingHouseI = clearingHouses[i];
			const clearingHouseUserI = _userAccountInfos[i];
			const userCollateral = convertToNumber(
				clearingHouseUserI.getSpotMarketAssetValue(),
				QUOTE_PRECISION
			);

			const unsettledPnl = clearingHouseUserI
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
			await clearingHouseI.unsubscribe();
			await clearingHouseUserI.unsubscribe();
		}

		const market0 = clearingHouseOld.getPerpMarketAccount(0);

		console.log('total Fees:', market0.amm.totalFee.toString());
		console.log(
			'total Fees minus dist:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const spotMarketAccount = clearingHouseOld.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);

		const revPoolBalance = convertToNumber(
			getTokenAmount(
				spotMarketAccount.revenuePool.balance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const pnlPoolBalance = convertToNumber(
			getTokenAmount(
				market0.pnlPool.balance,
				spotMarketAccount,
				SpotBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const feePoolBalance = convertToNumber(
			getTokenAmount(
				market0.amm.feePool.balance,
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

		assert(
			Math.abs(
				allUserCollateral +
					pnlPoolBalance +
					feePoolBalance -
					(usdcDepositBalance - usdcBorrowBalance)
			) < 1e-7
		);

		console.log(
			'market0.amm.netBaseAssetAmount:',
			market0.amm.netBaseAssetAmount.toString()
		);
		assert(market0.amm.netBaseAssetAmount.eq(new BN(0)));

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
