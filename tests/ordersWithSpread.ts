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
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('amm spread: market order', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let velocityClientUser: User;
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

		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);

		const marketIndexes = [0, 1];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH_LAZER },
		];

		velocityClient = new TestClient({
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
		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await velocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await velocityClient.updatePerpMarketBaseSpread(marketIndex, 500);

		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();
	});

	beforeEach(async () => {
		await velocityClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd, 10000);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Long market order base', async () => {
		const initialCollateral = velocityClient.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			velocityClient.getPerpMarketAccount(0),
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			velocityClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await velocityClient.placeAndTakePerpOrder(orderParams);
		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);
		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const unrealizedPnl = velocityClientUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const market = velocityClient.getPerpMarketAccount(marketIndex);
		const expectedQuoteAssetSurplus = new BN(250);
		const expectedExchangeFee = new BN(1001);
		const expectedFeeToMarket = expectedExchangeFee.add(
			expectedQuoteAssetSurplus
		);
		console.log(market.amm.totalFee.toString());
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const firstPosition = velocityClient.getUserAccount().perpPositions[0];
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

		await velocityClient.closePosition(marketIndex);

		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const pnl = velocityClient
			.getQuoteAssetTokenAmount()
			.sub(initialCollateral);
		assert(pnl.eq(new BN(-2502)));
		console.log(velocityClient.getPerpMarketAccount(0).amm.totalFee.toString());
		assert(
			velocityClient.getPerpMarketAccount(0).amm.totalFee.eq(new BN(2501))
		);
	});

	it('short market order base', async () => {
		const initialCollateral = velocityClient.getQuoteAssetTokenAmount();
		const initialAmmTotalFee =
			velocityClient.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			velocityClient.getPerpMarketAccount(0),
			'base',
			undefined,
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			velocityClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);
		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await velocityClient.placeAndTakePerpOrder(orderParams);
		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const unrealizedPnl = velocityClientUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert.ok(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));
		console.log('surplus', orderRecord.quoteAssetAmountSurplus.toString());

		console.log(orderRecord.quoteAssetAmountSurplus.toString());
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));

		await velocityClient.closePosition(marketIndex);

		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const pnl = velocityClient
			.getQuoteAssetTokenAmount()
			.sub(initialCollateral);
		console.log(pnl.toString());
		assert(pnl.eq(new BN(-2502)));

		console.log(
			velocityClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.toString()
		);
		assert(
			velocityClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('unable to fill bid between mark and ask price', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			velocityClient.getPerpMarketAccount(0),
			undefined
		).add(PRICE_PRECISION.div(new BN(10000))); // limit price plus 1bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});

		await velocityClient.placePerpOrder(orderParams);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const unfilledOrder = velocityClientUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			unfilledOrder,
			velocityClient.getPerpMarketAccount(0),
			velocityClient.getOracleDataForPerpMarket(unfilledOrder.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(ZERO));

		// fill should fail because nothing to fill
		try {
			await velocityClient.fillPerpOrder(
				await velocityClientUser.getUserAccountPublicKey(),
				velocityClientUser.getUserAccount(),
				unfilledOrder
			);
			assert(false);
		} catch (e) {
			// good
		}

		await velocityClient.cancelOrderByUserId(1);
	});

	it('unable to fill ask between mark and bid price', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			velocityClient.getPerpMarketAccount(0),
			undefined
		).add(PRICE_PRECISION.sub(new BN(10000))); // limit price plus 1bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await velocityClient.placePerpOrder(orderParams);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const unfilledOrder = velocityClientUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			unfilledOrder,
			velocityClient.getPerpMarketAccount(0),
			velocityClient.getOracleDataForPerpMarket(unfilledOrder.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(ZERO));

		// fill should fail because nothing to fill
		try {
			await velocityClient.fillPerpOrder(
				await velocityClientUser.getUserAccountPublicKey(),
				velocityClientUser.getUserAccount(),
				unfilledOrder
			);
			assert(false);
		} catch (e) {
			// good
		}

		await velocityClient.cancelOrderByUserId(1);
	});

	it('fill limit order above ask', async () => {
		const initialAmmTotalFee =
			velocityClient.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.LONG;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			velocityClient.getPerpMarketAccount(0),
			undefined
		).add(PRICE_PRECISION.div(new BN(1000))); // limit price plus 10bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await velocityClient.placePerpOrder(orderParams);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const order = velocityClientUser.getUserAccount().orders[0];

		console.log(order.baseAssetAmount.toString());
		console.log(
			velocityClientUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			velocityClient.getPerpMarketAccount(0),
			velocityClient.getOracleDataForPerpMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			velocityClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();

		const txSig = await velocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const firstOrder = velocityClientUser.getUserAccount().orders[0];
		const firstPosition = velocityClientUser.getUserAccount().perpPositions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());
		console.log(firstPosition.quoteBreakEvenAmount.toString());

		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(-1001252)));

		await velocityClient.closePosition(marketIndex);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		assert(
			velocityClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('fill limit order below bid', async () => {
		const initialAmmTotalFee =
			velocityClient.getPerpMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = AMM_RESERVE_PRECISION;
		const limitPrice = calculateReservePrice(
			velocityClient.getPerpMarketAccount(0),
			undefined
		).sub(PRICE_PRECISION.div(new BN(1000))); // limit price minus 10bp

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
			userOrderId: 1,
		});
		await velocityClient.placePerpOrder(orderParams);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const order = velocityClientUser.getUserAccount().orders[0];

		console.log(order.baseAssetAmount.toString());
		console.log(
			velocityClientUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);

		const expectedBaseAssetAmount = calculateBaseAssetAmountForAmmToFulfill(
			order,
			velocityClient.getPerpMarketAccount(0),
			velocityClient.getOracleDataForPerpMarket(order.marketIndex),
			0
		);
		assert(expectedBaseAssetAmount.eq(AMM_RESERVE_PRECISION));

		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			velocityClient.getPerpMarketAccount(0),
			'base',
			undefined,
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			velocityClient.getPerpMarketAccount(marketIndex).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);

		const txSig = await velocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const firstOrder = velocityClientUser.getUserAccount().orders[0];
		const firstPosition = velocityClientUser.getUserAccount().perpPositions[0];
		console.log(firstOrder.baseAssetAmount.toString());
		console.log(firstPosition.baseAssetAmount.toString());
		console.log(firstPosition.quoteBreakEvenAmount.toString());

		assert(firstPosition.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(998750)));

		await velocityClient.closePosition(marketIndex);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		assert(
			velocityClient
				.getPerpMarketAccount(0)
				.amm.totalFee.sub(initialAmmTotalFee)
				.eq(new BN(2501))
		);
	});

	it('Long market order base w/ variable reduce/close', async () => {
		const marketIndex2Num = 1;
		const marketIndex2 = marketIndex2Num;
		const peg = 40000;
		const btcUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			peg,
			-7,
			undefined,
			10000
		);

		const periodicity = new BN(60 * 60); // 1 HOUR
		const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
		const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 15).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 15).mul(
			mantissaSqrtScale
		);

		await velocityClient.initializePerpMarket(
			marketIndex2,
			btcUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(peg * PEG_PRECISION.toNumber())
		);

		await velocityClient.updatePerpMarketBaseSpread(marketIndex2, 500);
		const initialCollateral = velocityClient.getQuoteAssetTokenAmount();
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.toNumber() / 10000); // ~$4 of btc
		const market2 = velocityClient.getPerpMarketAccount(marketIndex2Num);

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
			velocityClient.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
			getSwapDirection('base', direction)
		).neg();
		console.log(
			'expected quote with out spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsNoSpread[1].abs(),
				velocityClient.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);
		console.log(
			'expected quote with spread',
			calculateQuoteAssetAmountSwapped(
				tradeAcquiredAmountsWithSpread[1].abs(),
				velocityClient.getPerpMarketAccount(marketIndex2Num).amm.pegMultiplier,
				getSwapDirection('base', direction)
			).toString()
		);

		const orderParams = getMarketOrderParams({
			marketIndex: marketIndex2,
			direction,
			baseAssetAmount,
		});
		const txSig = await velocityClient.placeAndTakePerpOrder(orderParams);
		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const unrealizedPnl = velocityClientUser.getUnrealizedPNL();
		console.log('unrealized pnl', unrealizedPnl.toString());

		const expectedFeeToMarket = new BN(1040);
		const firstPosition = velocityClient.getUserAccount().perpPositions[1];
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
				await velocityClient.placeAndTakePerpOrder(orderParams);
			} catch (e) {
				console.error(e);
			}
		}
		try {
			await velocityClient.closePosition(marketIndex2); // close rest
		} catch (e) {
			console.error(e);
		}
		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();

		const pnl = velocityClient
			.getQuoteAssetTokenAmount()
			.sub(initialCollateral);

		console.log('pnl', pnl.toString());
		console.log(
			'total fee',
			velocityClient
				.getPerpMarketAccount(marketIndex2Num)
				.amm.totalFee.toString()
		);
		assert(
			velocityClient
				.getPerpMarketAccount(marketIndex2Num)
				.amm.totalFee.eq(new BN(10041))
		);
	});
});
