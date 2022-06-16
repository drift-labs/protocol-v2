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
	QUOTE_PRECISION,
	ZERO,
	calculateQuoteAssetAmountSwapped,
	EventSubscriber,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	calculateBaseAssetAmountMarketCanExecute,
	calculateMarkPrice,
	getLimitOrderParams,
	getSwapDirection,
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

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		solUsd = await mockOracle(1);

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

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
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

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			ZERO,
			baseAssetAmount,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryRecord =
			eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
		assert.ok(
			tradeHistoryRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket)
		);
		console.log(
			'surplus',
			tradeHistoryRecord.quoteAssetAmountSurplus.toString()
		);

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0].data;
		assert(orderRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouse.getQuoteAssetTokenAmount().sub(initialCollateral);
		console.log(pnl.toString());
		console.log(clearingHouse.getMarketAccount(0).amm.totalFee.toString());
		assert(clearingHouse.getMarketAccount(0).amm.totalFee.eq(new BN(500)));
	});

	it('Long market order quote', async () => {
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const initialAmmTotalFee = clearingHouse.getMarketAccount(0).amm.totalFee;
		const direction = PositionDirection.LONG;
		const quoteAssetAmount = new BN(QUOTE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarketAccount(0),
			'quote',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarketAccount(0),
			'quote',
			true
		);
		console.log(
			'expected base with out spread',
			tradeAcquiredAmountsNoSpread[0].abs().toString()
		);
		console.log(
			'expected base with spread',
			tradeAcquiredAmountsWithSpread[0].abs().toString()
		);
		const expectedBaseAssetAmount = tradeAcquiredAmountsWithSpread[0].abs();

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			quoteAssetAmount,
			ZERO,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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

		const tradeHistoryRecord =
			eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(expectedBaseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(quoteAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmountSurplus.eq(new BN(250)));
		console.log(
			'surplus',
			tradeHistoryRecord.quoteAssetAmountSurplus.toString()
		);

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0].data;
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouseUser
			.getUserAccount()
			.collateral.sub(initialCollateral);
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

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			ZERO,
			baseAssetAmount,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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

		const tradeHistoryRecord =
			eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmountSurplus.eq(new BN(250)));
		console.log(
			'surplus',
			tradeHistoryRecord.quoteAssetAmountSurplus.toString()
		);

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0].data;
		console.log(orderRecord.quoteAssetAmountSurplus.toString());
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouseUser
			.getUserAccount()
			.collateral.sub(initialCollateral);
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

	it('short market order quote', async () => {
		const initialCollateral = clearingHouse.getQuoteAssetTokenAmount();
		const initialAmmTotalFee = clearingHouse.getMarketAccount(0).amm.totalFee;

		const direction = PositionDirection.SHORT;
		const quoteAssetAmount = new BN(QUOTE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarketAccount(0),
			'quote',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarketAccount(0),
			'quote',
			true
		);
		console.log(
			'expected base with out spread',
			tradeAcquiredAmountsNoSpread[0].abs().toString()
		);
		console.log(
			'expected base with spread',
			tradeAcquiredAmountsWithSpread[0].abs().toString()
		);

		const expectedBaseAssetAmount = tradeAcquiredAmountsWithSpread[0].abs();

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			quoteAssetAmount,
			ZERO,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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

		const tradeHistoryRecord =
			eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(expectedBaseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(quoteAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmountSurplus.eq(new BN(250)));
		console.log(
			'surplus',
			tradeHistoryRecord.quoteAssetAmountSurplus.toString()
		);

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0].data;
		console.log(orderRecord.quoteAssetAmountSurplus.toString());
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(250)));

		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouseUser
			.getUserAccount()
			.collateral.sub(initialCollateral);
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

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			undefined,
			false,
			1
		);

		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unfilledOrder = clearingHouseUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountMarketCanExecute(
			clearingHouse.getMarketAccount(0),
			unfilledOrder
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

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			undefined,
			false,
			1
		);
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const unfilledOrder = clearingHouseUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountMarketCanExecute(
			clearingHouse.getMarketAccount(0),
			unfilledOrder
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

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			undefined,
			false,
			1
		);
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountMarketCanExecute(
			clearingHouse.getMarketAccount(0),
			order
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

		try {
			await clearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
		} catch (e) {
			console.error(e);
		}

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

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

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			undefined,
			false,
			1
		);
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];
		const expectedBaseAssetAmount = calculateBaseAssetAmountMarketCanExecute(
			clearingHouse.getMarketAccount(0),
			order
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

		await clearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		assert(firstPosition.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

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
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			market2,
			'base',
			true
		);

		const expectedQuoteAssetAmount = calculateQuoteAssetAmountSwapped(
			tradeAcquiredAmountsWithSpread[1].abs(),
			clearingHouse.getMarketAccount(marketIndex2Num).amm.pegMultiplier,
			getSwapDirection('base', direction)
		);
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

		const orderParams = getMarketOrderParams(
			marketIndex2,
			direction,
			ZERO,
			baseAssetAmount,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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
		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		console.log(
			convertToNumber(firstPosition.baseAssetAmount),
			convertToNumber(baseAssetAmount)
		);
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		console.log(
			convertToNumber(firstPosition.quoteAssetAmount),
			convertToNumber(expectedQuoteAssetAmount)
		);
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount)); //todo

		const tradeHistoryRecord =
			eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
		assert.ok(
			tradeHistoryRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket)
		);
		console.log(
			'surplus',
			tradeHistoryRecord.quoteAssetAmountSurplus.toString()
		);

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0].data;
		assert(orderRecord.quoteAssetAmountSurplus.eq(expectedFeeToMarket));

		const numCloses = 10;
		const directionToClose = PositionDirection.SHORT;

		for (let i = numCloses; i > 0; i--) {
			const orderParams = getMarketOrderParams(
				marketIndex2,
				directionToClose,
				ZERO,
				baseAssetAmount.div(new BN(numCloses * i)), // variable sized close
				false
			);
			await clearingHouse.placeAndFillOrder(orderParams);
		}
		await clearingHouse.closePosition(marketIndex2); // close rest

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const pnl = clearingHouseUser
			.getUserAccount()
			.collateral.sub(initialCollateral);
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
