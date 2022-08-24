import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ClearingHouseUser,
	getMarketOrderParams,
	findComputeUnitConsumption,
	AMM_RESERVE_PRECISION,
	calculateTradeAcquiredAmounts,
	convertToNumber,
	FeeStructure,
	ZERO,
	calculateQuoteAssetAmountSwapped,
	EventSubscriber,
	calculateBaseAssetAmountForAmmToFulfill,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	setFeedPrice,
} from './testHelpers';
import {
	calculateMarkPrice,
	getLimitOrderParams,
	getSwapDirection,
	OracleSource,
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
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = new BN(0);
	let solUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);

		const marketIndexes = [new BN(0)];
		const bankIndexes = [new BN(0)];
		const oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.updateMarketBaseSpread(marketIndex, 500);
		const feeStructure: FeeStructure = {
			feeNumerator: new BN(0), // 5bps
			feeDenominator: new BN(10000),
			discountTokenTiers: {
				firstTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
			},
			referralDiscount: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeDiscountNumerator: new BN(1),
				refereeDiscountDenominator: new BN(1),
			},
		};
		await clearingHouse.updateFee(feeStructure);

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
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			ZERO
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
			clearingHouse.getMarketAccount(0),
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
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

		const market = clearingHouse.getMarketAccount(marketIndex);
		const expectedFeeToMarket = new BN(250);
		console.log(market.amm.totalFee.toString());
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const firstPosition = clearingHouse.getUserAccount().positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		console.log(
			'expectedQuoteAssetAmount:',
			firstPosition.quoteEntryAmount.toString(),
			expectedQuoteAssetAmount.toString()
		);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);
		assert.ok(orderRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket));

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
		console.log(clearingHouse.getMarketAccount(0).amm.totalFee.toString());
		assert(clearingHouse.getMarketAccount(0).amm.totalFee.eq(new BN(500)));
	});

	it('short market order base', async () => {
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const initialAmmTotalFee = clearingHouse.getMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarketAccount(0),
			'base',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarketAccount(0),
			'base',
			true
		);
		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
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

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

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
		console.log(
			clearingHouse
				.getMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.toString()
		);
		assert(
			clearingHouse
				.getMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(500))
		);
	});

	it('unable to fill bid between mark and ask price', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(0)
		).add(MARK_PRICE_PRECISION.div(new BN(10000))); // limit price plus 1bp

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
			clearingHouse.getMarketAccount(0),
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
		const limitPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(0)
		).add(MARK_PRICE_PRECISION.sub(new BN(10000))); // limit price plus 1bp

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
			clearingHouse.getMarketAccount(0),
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
		const initialAmmTotalFee = clearingHouse.getMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(0)
		).add(MARK_PRICE_PRECISION.div(new BN(1000))); // limit price plus 10bp

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
			clearingHouseUser.getUserAccount().positions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			clearingHouse.getMarketAccount(0),
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarketAccount(0),
			'base',
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
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
		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());

		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouse
				.getMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(500))
		);
	});

	it('fill limit order below bid', async () => {
		const initialAmmTotalFee = clearingHouse.getMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateMarkPrice(
			clearingHouse.getMarketAccount(0)
		).sub(MARK_PRICE_PRECISION.div(new BN(1000))); // limit price minus 10bp

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
			clearingHouseUser.getUserAccount().positions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			clearingHouse.getMarketAccount(0),
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarketAccount(0),
			'base',
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getMarketAccount(marketIndex).amm.pegMultiplier,
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
		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());

		assert(firstPosition.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouse
				.getMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(500))
		);
	});

	it('Long market order base w/ variable reduce/close', async () => {
		const marketIndex2Num = 1;
		const marketIndex2 = new BN(marketIndex2Num);
		const peg = 40000;
		const btcUsd = await mockOracle(peg);

		const periodicity = new BN(60 * 60); // 1 HOUR
		const mantissaSqrtScale = new BN(
			Math.sqrt(MARK_PRICE_PRECISION.toNumber())
		);
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
			new BN(peg * 1e3)
		);

		await clearingHouse.updateMarketBaseSpread(marketIndex2, 500);
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.toNumber() / 10000); // ~$4 of btc
		const market2 = clearingHouse.getMarketAccount(marketIndex2Num);

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
			clearingHouse.getMarketAccount(marketIndex2Num).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				clearingHouse.getMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				clearingHouse.getMarketAccount(marketIndex2Num).amm.pegMultiplier,
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

		const expectedFeeToMarket = new BN(1000);
		const firstPosition = clearingHouse.getUserAccount().positions[1];
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

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);
		assert.ok(orderRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket));
		console.log('surplus', orderRecord.quoteAssetAmountSurplus.toString());

		const numCloses = 10;
		const directionToClose = PositionDirection.SHORT;

		for (let i = numCloses; i > 0; i--) {
			const orderParams = getMarketOrderParams({
				marketIndex: marketIndex2,
				direction: directionToClose,
				baseAssetAmount: baseAssetAmount.div(new BN(numCloses * i)), // variable sized close
			});
			await clearingHouse.placeAndTake(orderParams);
		}
		await clearingHouse.closePosition(marketIndex2); // close rest
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
			clearingHouse.getMarketAccount(marketIndex2Num).amm.totalFee.toString()
		);
		assert(
			clearingHouse
				.getMarketAccount(marketIndex2Num)
				.amm.totalFee.eq(new BN(2000))
		);
	});
});
