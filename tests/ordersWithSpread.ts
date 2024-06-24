import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	getMarketOrderParams,
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
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import {
	calculateReservePrice,
	getLimitOrderParams,
	getSwapDirection,
	OracleSource,
	PEG_PRECISION,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('amm spread: market order', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let driftClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);

		const marketIndexes = [0, 1];
		const spotMarketIndexes = [0];
		const oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.updatePerpMarketBaseSpread(marketIndex, 500);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();
	});

	beforeEach(async () => {
		await driftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Long market order base', async () => {
		const initialCollateral = driftClient.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			driftClient.getPerpMarketAccount(0),
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			driftClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await driftClient.placeAndTakePerpOrder(orderParams);
		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const unrealizedPnl = driftClientUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const market = driftClient.getPerpMarketAccount(marketIndex);
		const expectedQuoteAssetSurplus = new BN(250);
		const expectedExchangeFee = new BN(1001);
		const expectedFeeToMarket = expectedExchangeFee.add(
			expectedQuoteAssetSurplus
		);
		console.log(market.amm.totalFee.toString());
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const firstPosition = driftClient.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		console.log(
			'expectedQuoteAssetAmount:',
			firstPosition.quoteBreakEvenAmount.toString(),
			expectedQuoteAssetAmount.toString()
		);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(-1001252)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);
		assert.ok(
			orderRecord.quoteAssetAmountSurplus.eq(expectedQuoteAssetSurplus)
		);

		await driftClient.closePosition(marketIndex);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const pnl = driftClient.getQuoteAssetTokenAmount().sub(initialCollateral);
		assert(pnl.eq(new BN(-2502)));
		console.log(driftClient.getPerpMarketAccount(0).amm.totalFee.toString());
		assert(driftClient.getPerpMarketAccount(0).amm.totalFee.eq(new BN(2501)));
	});

	it('short market order base', async () => {
		const initialCollateral = driftClient.getQuoteAssetTokenAmount();
		const initialAmmTotalFee = driftClient.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			driftClient.getPerpMarketAccount(0),
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			driftClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);
		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await driftClient.placeAndTakePerpOrder(orderParams);
		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const unrealizedPnl = driftClientUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert.ok(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));
		console.log('surplus', orderRecord.quoteAssetAmountSurplus.toString());

		console.log(orderRecord.quoteAssetAmountSurplus.toString());
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));

		await driftClient.closePosition(marketIndex);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const pnl = driftClient.getQuoteAssetTokenAmount().sub(initialCollateral);
		console.log(pnl.toString());
		assert(pnl.eq(new BN(-2502)));

		console.log(
			driftClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.toString()
		);
		assert(
			driftClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('unable to fill bid between mark and ask price', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(0),
			undefined
		).add(PRICE_PRECISION.div(new BN(10000))); // limit price plus 1bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});

		await driftClient.placePerpOrder(orderParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const unfilledOrder = driftClientUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			unfilledOrder,
			driftClient.getPerpMarketAccount(0),
			driftClient.getOracleDataForPerpMarket(unfilledOrder.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(ZERO));

		// fill should fail because nothing to fill
		try {
			await driftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				unfilledOrder
			);
			assert(false);
		} catch (e) {
			// good
		}

		await driftClient.cancelOrderByUserId(1);
	});

	it('unable to fill ask between mark and bid price', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(0),
			undefined
		).add(PRICE_PRECISION.sub(new BN(10000))); // limit price plus 1bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(orderParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const unfilledOrder = driftClientUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			unfilledOrder,
			driftClient.getPerpMarketAccount(0),
			driftClient.getOracleDataForPerpMarket(unfilledOrder.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(ZERO));

		// fill should fail because nothing to fill
		try {
			await driftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				unfilledOrder
			);
			assert(false);
		} catch (e) {
			// good
		}

		await driftClient.cancelOrderByUserId(1);
	});

	it('fill limit order above ask', async () => {
		const initialAmmTotalFee = driftClient.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(0),
			undefined
		).add(PRICE_PRECISION.div(new BN(1000))); // limit price plus 10bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(orderParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const order = driftClientUser.getUserAccount().orders[0];

		console.log(order.baseAssetAmount.toString());
		console.log(
			driftClientUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			driftClient.getPerpMarketAccount(0),
			driftClient.getOracleDataForPerpMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			driftClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();

		const txSig = await driftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const firstOrder = driftClientUser.getUserAccount().orders[0];
		const firstPosition = driftClientUser.getUserAccount().perpPositions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());
		console.log(firstPosition.quoteBreakEvenAmount.toString());

		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(-1001252)));

		await driftClient.closePosition(marketIndex);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		assert(
			driftClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('fill limit order below bid', async () => {
		const initialAmmTotalFee = driftClient.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(0),
			undefined
		).sub(PRICE_PRECISION.div(new BN(1000))); // limit price minus 10bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(orderParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const order = driftClientUser.getUserAccount().orders[0];

		console.log(order.baseAssetAmount.toString());
		console.log(
			driftClientUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			driftClient.getPerpMarketAccount(0),
			driftClient.getOracleDataForPerpMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			driftClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			driftClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);

		const txSig = await driftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const firstOrder = driftClientUser.getUserAccount().orders[0];
		const firstPosition = driftClientUser.getUserAccount().perpPositions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());
		console.log(firstPosition.quoteBreakEvenAmount.toString());

		assert(firstPosition.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(998750)));

		await driftClient.closePosition(marketIndex);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		assert(
			driftClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('Long market order base w/ variable reduce/close', async () => {
		const marketIndex2Num = 1;
		const marketIndex2 = marketIndex2Num;
		const peg = 40000;
		const btcUsd = await mockOracleNoProgram(bankrunContextWrapper, peg);

		const periodicity = new BN(60 * 60); // 1 HOUR
		const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
		const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 15).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 15).mul(
			mantissaSqrtScale
		);

		await driftClient.initializePerpMarket(
			marketIndex2,
			btcUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(peg * PEG_PRECISION.toNumber())
		);

		await driftClient.updatePerpMarketBaseSpread(marketIndex2, 500);
		const initialCollateral = driftClient.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.toNumber() / 10000); // ~$4 of btc
		const market2 = driftClient.getPerpMarketAccount(marketIndex2Num);

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
			driftClient.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				driftClient.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				driftClient.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex: marketIndex2,
			direction,
			baseAssetAmount,
		});
		const txSig = await driftClient.placeAndTakePerpOrder(orderParams);
		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const unrealizedPnl = driftClientUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const expectedFeeToMarket = new BN(1040);
		const firstPosition = driftClient.getUserAccount().perpPositions[1];
		console.log(
			convertToNumber(firstPosition.baseAssetAmount),
			convertToNumber(baseAssetAmount)
		);
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		console.log(
			convertToNumber(firstPosition.quoteAssetAmount),
			convertToNumber(expectedQuoteAssetAmount)
		);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(-4005043))); //todo

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
				await driftClient.placeAndTakePerpOrder(orderParams);
			} catch (e) {
				console.error(e);
			}
		}
		try {
			await driftClient.closePosition(marketIndex2); // close rest
		} catch (e) {
			console.error(e);
		}
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const pnl = driftClient.getQuoteAssetTokenAmount().sub(initialCollateral);

		console.log('pnl', pnl.toString());
		console.log(
			'total fee',
			driftClient.getPerpMarketAccount(marketIndex2Num).amm.totalFee.toString()
		);
		assert(
			driftClient
				.getPerpMarketAccount(marketIndex2Num)
				.amm.totalFee.eq(new BN(10041))
		);
	});
});
