import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	ClearingHouseUser,
	getMarketOrderParams,
	findComputeUnitConsumption,
	AMM_RESERVE_PRECISION,
	calculateTradeAcquiredAmounts,
	convertToNumber,
	ZERO,
	calculateQuoteAssetAmountSwapped,
	EventSubscriber,
	calculateBaseAssetAmountForAmmToFulfill,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	setFeedPrice,
} from './testHelpers';
import {
	calculateReservePrice,
	getLimitOrderParams,
	getSwapDirection,
	OracleSource,
	PEG_PRECISION,
} from '../sdk';

describe('amm spread: market order', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = 0;
	let solUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);

		const marketIndexes = [0];
		const spotMarketIndexes = [0];
		const oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

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
			oracleInfos,
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.updateMarketBaseSpread(marketIndex, 500);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await clearingHouse.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Long market order base', async () => {
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(0),
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await clearingHouse.placeAndTake(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unrealizedPnl = clearingHouseUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const expectedQuoteAssetSurplus = new BN(250);
		const expectedExchangeFee = new BN(1001);
		const expectedFeeToMarket = expectedExchangeFee.add(
			expectedQuoteAssetSurplus
		);
		console.log(market.amm.totalFee.toString());
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const firstPosition = clearingHouse.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		console.log(
			'expectedQuoteAssetAmount:',
			firstPosition.quoteEntryAmount.toString(),
			expectedQuoteAssetAmount.toString()
		);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);
		assert.ok(
			orderRecord.quoteAssetAmountSurplus.eq(expectedQuoteAssetSurplus)
		);

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouse.getQuoteAssetTokenAmount().sub(initialCollateral);
		assert(pnl.eq(new BN(-2502)));
		console.log(clearingHouse.getPerpMarketAccount(0).amm.totalFee.toString());
		assert(clearingHouse.getPerpMarketAccount(0).amm.totalFee.eq(new BN(2501)));
	});

	it('short market order base', async () => {
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const initialAmmTotalFee =
			clearingHouse.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(0),
			'base',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(0),
			'base',
			true
		);
		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await clearingHouse.placeAndTake(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unrealizedPnl = clearingHouseUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert.ok(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));
		console.log('surplus', orderRecord.quoteAssetAmountSurplus.toString());

		console.log(orderRecord.quoteAssetAmountSurplus.toString());
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouse.getQuoteAssetTokenAmount().sub(initialCollateral);
		console.log(pnl.toString());
		assert(pnl.eq(new BN(-2502)));

		console.log(
			clearingHouse
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.toString()
		);
		assert(
			clearingHouse
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('unable to fill bid between mark and ask price', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(0)
		).add(PRICE_PRECISION.div(new BN(10000))); // limit price plus 1bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});

		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unfilledOrder = clearingHouseUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			unfilledOrder,
			clearingHouse.getPerpMarketAccount(0),
			clearingHouse.getOracleDataForMarket(unfilledOrder.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(ZERO));

		// fill should fail because nothing to fill
		try {
			await clearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				unfilledOrder
			);
			assert(false);
		} catch (e) {
			// good
		}

		await clearingHouse.cancelOrderByUserId(1);
	});

	it('unable to fill ask between mark and bid price', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(0)
		).add(PRICE_PRECISION.sub(new BN(10000))); // limit price plus 1bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unfilledOrder = clearingHouseUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			unfilledOrder,
			clearingHouse.getPerpMarketAccount(0),
			clearingHouse.getOracleDataForMarket(unfilledOrder.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(ZERO));

		// fill should fail because nothing to fill
		try {
			await clearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				unfilledOrder
			);
			assert(false);
		} catch (e) {
			// good
		}

		await clearingHouse.cancelOrderByUserId(1);
	});

	it('fill limit order above ask', async () => {
		const initialAmmTotalFee =
			clearingHouse.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(0)
		).add(PRICE_PRECISION.div(new BN(1000))); // limit price plus 10bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];

		console.log(order.baseAssetAmount.toString());
		console.log(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			clearingHouse.getPerpMarketAccount(0),
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(0),
			'base',
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();

		const txSig = await clearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await printTxLogs(connection, txSig);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const firstOrder = clearingHouseUser.getUserAccount().orders[0];
		const firstPosition = clearingHouseUser.getUserAccount().perpPositions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());

		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouse
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('fill limit order below bid', async () => {
		const initialAmmTotalFee =
			clearingHouse.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			clearingHouse.getPerpMarketAccount(0)
		).sub(PRICE_PRECISION.div(new BN(1000))); // limit price minus 10bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];

		console.log(order.baseAssetAmount.toString());
		console.log(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			clearingHouse.getPerpMarketAccount(0),
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(0),
			'base',
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);

		const txSig = await clearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await printTxLogs(connection, txSig);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const firstOrder = clearingHouseUser.getUserAccount().orders[0];
		const firstPosition = clearingHouseUser.getUserAccount().perpPositions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());

		assert(firstPosition.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouse
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('Long market order base w/ variable reduce/close', async () => {
		const marketIndex2Num = 1;
		const marketIndex2 = marketIndex2Num;
		const peg = 40000;
		const btcUsd = await mockOracle(peg);

		const periodicity = new BN(60 * 60); // 1 HOUR
		const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
		const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 15).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 15).mul(
			mantissaSqrtScale
		);

		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(peg * PEG_PRECISION.toNumber())
		);

		await clearingHouse.updateMarketBaseSpread(marketIndex2, 500);
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.toNumber() / 10000); // ~$4 of btc
		const market2 = clearingHouse.getPerpMarketAccount(marketIndex2Num);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			market2,
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			market2,
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				clearingHouse.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				clearingHouse.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex: marketIndex2,
			direction,
			baseAssetAmount,
		});
		const txSig = await clearingHouse.placeAndTake(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unrealizedPnl = clearingHouseUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const expectedFeeToMarket = new BN(1040);
		const firstPosition = clearingHouse.getUserAccount().perpPositions[1];
		console.log(
			convertToNumber(firstPosition.baseAssetAmount),
			convertToNumber(baseAssetAmount)
		);
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		console.log(
			convertToNumber(firstPosition.quoteAssetAmount),
			convertToNumber(expectedQuoteAssetAmount)
		);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount)); //todo

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);
		console.log('surplus', orderRecord.quoteAssetAmountSurplus.toString());
		assert.ok(orderRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket));

		const numCloses = 10;
		const directionToClose = PositionDirection.SHORT;

		for (let i = numCloses; i > 0; i--) {
			const orderParams = getMarketOrderParams({
				marketIndex: marketIndex2,
				direction: directionToClose,
				baseAssetAmount: baseAssetAmount.div(new BN(numCloses * i)), // variable sized close
			});
			try {
				await clearingHouse.placeAndTake(orderParams);
			} catch (e) {
				console.error(e);
			}
		}
		try {
			await clearingHouse.closePosition(marketIndex2); // close rest
		} catch (e) {
			console.error(e);
		}
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouse.getQuoteAssetTokenAmount().sub(initialCollateral);

		console.log('pnl', pnl.toString());
		console.log(
			'total fee',
			clearingHouse
				.getPerpMarketAccount(marketIndex2Num)
				.amm.totalFee.toString()
		);
		assert(
			clearingHouse
				.getPerpMarketAccount(marketIndex2Num)
				.amm.totalFee.eq(new BN(10041))
		);
	});
});
