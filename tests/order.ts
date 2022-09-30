import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	OrderStatus,
	OrderAction,
	OrderTriggerCondition,
	calculateTargetPriceTrade,
	convertToNumber,
	QUOTE_PRECISION,
	Wallet,
	calculateTradeSlippage,
	getLimitOrderParams,
	getTriggerMarketOrderParams,
	EventSubscriber,
	standardizeBaseAssetAmount,
	calculateBaseAssetAmountForAmmToFulfill,
	OracleGuardRails,
} from '../sdk/src';

import {
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	initializeQuoteSpotMarket,
	printTxLogs,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateReservePrice,
	findComputeUnitConsumption,
	getMarketOrderParams,
	isVariant,
	OracleSource,
	PEG_PRECISION,
	TEN_THOUSAND,
	TWO,
	ZERO,
} from '../sdk';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('orders', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

	let whaleAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 11).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 11).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const whaleKeyPair = new Keypair();
	const usdcAmountWhale = new BN(10000000 * 10 ** 6);
	let whaleUSDCAccount: Keypair;
	let whaleClearingHouse: ClearingHouse;
	let whaleUser: ClearingHouseUser;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

	const marketIndex = 0;
	const marketIndexBTC = 1;
	const marketIndexEth = 2;

	let solUsd;
	let btcUsd;
	let ethUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);
		ethUsd = await mockOracle(1);

		const marketIndexes = [marketIndex, marketIndexBTC, marketIndexEth];
		const bankIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
			{ publicKey: ethUsd, source: OracleSource.PYTH },
		];

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
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

		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000 * PEG_PRECISION.toNumber()) // btc-ish price level
		);

		await clearingHouse.initializeMarket(
			ethUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerClearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(fillerKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			oracleInfos,
		});
		await fillerClearingHouse.subscribe();

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = new ClearingHouseUser({
			clearingHouse: fillerClearingHouse,
			userAccountPublicKey: await fillerClearingHouse.getUserAccountPublicKey(),
		});
		await fillerUser.subscribe();

		provider.connection.requestAirdrop(whaleKeyPair.publicKey, 10 ** 9);
		whaleUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmountWhale,
			provider,
			whaleKeyPair.publicKey
		);
		whaleClearingHouse = new Admin({
			connection,
			wallet: new Wallet(whaleKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			oracleInfos,
			userStats: true,
		});
		await whaleClearingHouse.subscribe();

		[, whaleAccountPublicKey] =
			await whaleClearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmountWhale,
				whaleUSDCAccount.publicKey
			);

		whaleUser = new ClearingHouseUser({
			clearingHouse: whaleClearingHouse,
			userAccountPublicKey: await whaleClearingHouse.getUserAccountPublicKey(),
		});

		await whaleUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await fillerUser.unsubscribe();

		await whaleClearingHouse.unsubscribe();
		await whaleUser.unsubscribe();

		await eventSubscriber.unsubscribe();
	});

	it('Open long limit order', async () => {
		// user has $10, no open positions, trading in market of $1 mark price coin
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = PRICE_PRECISION.add(PRICE_PRECISION.div(new BN(100)));
		const reduceOnly = false;
		const triggerPrice = new BN(0);

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
		});

		const txSig = await clearingHouse.placeOrder(orderParams);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const expectedOrderId = 1;

		assert(order.baseAssetAmount.eq(baseAssetAmount));
		assert(order.price.eq(price));
		assert(order.triggerPrice.eq(triggerPrice));
		assert(order.marketIndex === marketIndex);
		assert(order.reduceOnly === reduceOnly);
		assert(enumsAreEqual(order.direction, direction));
		assert(enumsAreEqual(order.status, OrderStatus.OPEN));
		assert(order.orderId === expectedOrderId);
		assert(order.ts.gt(ZERO));

		const position = clearingHouseUser.getUserAccount().perpPositions[0];
		assert(position.openOrders === 1);
		assert(position.openBids.eq(baseAssetAmount));
		assert(position.openAsks.eq(ZERO));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(orderRecord.ts.gt(ZERO));
		assert(enumsAreEqual(orderRecord.action, OrderAction.PLACE));
		assert(
			orderRecord.taker.equals(
				await clearingHouseUser.getUserAccountPublicKey()
			)
		);
	});

	it('Cancel order', async () => {
		const orderIndex = new BN(0);
		await clearingHouse.cancelOrder(undefined);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const order =
			clearingHouseUser.getUserAccount().orders[orderIndex.toNumber()];

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex === 0);
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const position = clearingHouseUser.getUserAccount().perpPositions[0];
		assert(position.openOrders === 0);
		assert(position.openBids.eq(ZERO));
		assert(position.openAsks.eq(ZERO));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		const expectedOrderId = 1;
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.takerOrderId === expectedOrderId);
		assert(enumsAreEqual(orderRecord.action, OrderAction.CANCEL));
		assert(
			orderRecord.taker.equals(
				await clearingHouseUser.getUserAccountPublicKey()
			)
		);
	});

	it('Fill limit long order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = PRICE_PRECISION.add(PRICE_PRECISION.div(new BN(100)));
		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);

		console.log('markPrice:', calculateReservePrice(market0).toString());

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
		});

		await clearingHouse.placeOrder(orderParams);
		const orderIndex = new BN(0);
		const orderId = 2;
		await clearingHouseUser.fetchAccounts();
		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openBids.eq(baseAssetAmount)
		);
		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));

		let order = clearingHouseUser.getOrder(orderId);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await fillerClearingHouse.settlePNLs(
			[
				{
					settleeUserAccountPublicKey:
						await clearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: clearingHouse.getUserAccount(),
				},
				{
					settleeUserAccountPublicKey:
						await fillerClearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: fillerClearingHouse.getUserAccount(),
				},
			],
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));
		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));

		order = clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		const expectedFillerReward = new BN(100);
		console.log(
			'FillerReward: $',
			convertToNumber(
				fillerClearingHouse.getQuoteAssetTokenAmount().sub(usdcAmount),
				QUOTE_PRECISION
			)
		);
		console.log();
		assert(
			fillerClearingHouse
				.getQuoteAssetTokenAmount()
				.sub(usdcAmount)
				.eq(expectedFillerReward)
		);

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log('markPrice After:', calculateReservePrice(market).toString());

		const expectedFeeToMarket = new BN(900);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex === 0);
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const firstPosition = clearingHouseUser.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));
		assert(firstPosition.openBids.eq(new BN(0)));

		const expectedQuoteAssetAmount = new BN(-1000003);
		// console.log(convertToNumber(firstPosition.quoteAssetAmount, QUOTE_PRECISION),
		//  '!=',
		//  convertToNumber(expectedQuoteAssetAmount, QUOTE_PRECISION),
		//  );
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);

		const expectedFillRecordId = new BN(1);
		const expectedFee = new BN(1000);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.takerFee.eq(expectedFee));
		assert(orderRecord.takerOrderFee.eq(expectedFee));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.taker.equals(
				await clearingHouseUser.getUserAccountPublicKey()
			)
		);
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(
			orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount.abs())
		);
		assert(orderRecord.fillerReward.eq(expectedFillerReward));
		assert(orderRecord.fillRecordId.eq(expectedFillRecordId));
	});

	it('Fill stop short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = PRICE_PRECISION.sub(PRICE_PRECISION.div(new BN(10)));
		const triggerCondition = OrderTriggerCondition.ABOVE;
		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);

		console.log('markPrice:', calculateReservePrice(market0).toString());

		const orderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
		});
		await clearingHouse.placeOrder(orderParams);
		const orderId = 3;
		const orderIndex = new BN(0);
		await clearingHouseUser.fetchAccounts();
		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		let order = clearingHouseUser.getOrder(orderId);
		await fillerClearingHouse.triggerOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		const txSig = await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

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

		await fillerClearingHouse.settlePNLs(
			[
				{
					settleeUserAccountPublicKey:
						await clearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: clearingHouse.getUserAccount(),
				},
				{
					settleeUserAccountPublicKey:
						await fillerClearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: fillerClearingHouse.getUserAccount(),
				},
			],
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		order = clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		const expectedFillerReward = new BN(10200);
		console.log(
			'FillerReward: $',
			convertToNumber(
				fillerClearingHouse.getQuoteAssetTokenAmount().sub(usdcAmount),
				QUOTE_PRECISION
			)
		);
		assert(
			fillerClearingHouse
				.getQuoteAssetTokenAmount()
				.sub(usdcAmount)
				.eq(expectedFillerReward)
		);

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log('markPrice after:', calculateReservePrice(market).toString());

		const expectedFeeToMarket = new BN(1800);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex === 0);
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const firstPosition = clearingHouseUser.getUserAccount().perpPositions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(1000002);
		console.log(
			'expectedTradeQuoteAssetAmount check:',
			orderRecord.quoteAssetAmountFilled.toString(),
			'=',
			expectedTradeQuoteAssetAmount.toString()
		);
		assert.ok(
			orderRecord.quoteAssetAmountFilled.eq(expectedTradeQuoteAssetAmount)
		);

		const expectedOrderId = 3;
		const expectedFillRecordId = new BN(2);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.takerOrderId === expectedOrderId);
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.taker.equals(
				await clearingHouseUser.getUserAccountPublicKey()
			)
		);
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(
			orderRecord.quoteAssetAmountFilled.eq(expectedTradeQuoteAssetAmount)
		);
		assert(orderRecord.fillRecordId.eq(expectedFillRecordId));
	});

	it('Fail to fill limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const limitPrice = calculateReservePrice(market); // 0 liquidity at current mark price
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		let order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);

		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openAsks.eq(baseAssetAmount.neg())
		);
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		assert(amountToFill.eq(ZERO));

		console.log(amountToFill);

		const orderId = 4;

		await clearingHouseUser.fetchAccounts();
		const baseAssetAmountBefore =
			clearingHouseUser.getUserPosition(marketIndex).baseAssetAmount;
		order = clearingHouseUser.getOrder(orderId);
		console.log(order);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);
		const order2 = clearingHouseUser.getOrder(orderId);
		console.log(order2);

		await clearingHouse.cancelOrder(orderId);
		const baseAssetAmountAfter =
			clearingHouseUser.getUserPosition(marketIndex).baseAssetAmount;
		assert(baseAssetAmountBefore.eq(baseAssetAmountAfter));
	});

	it('Partial fill limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const limitPrice = calculateReservePrice(market).sub(new BN(1)); // 0 liquidity at current mark price
		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(!amountToPrice.eq(ZERO));
		assert(newDirection == direction);

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then short @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});

		await clearingHouse.placeOrder(orderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);

		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openAsks.eq(baseAssetAmount.neg())
		);
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		console.log(amountToFill);

		const orderId = 5;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const market2 = clearingHouse.getPerpMarketAccount(marketIndex);
		const order2 = clearingHouseUser.getUserAccount().orders[0];
		console.log(
			'order filled: ',
			convertToNumber(order.baseAssetAmount),
			'->',
			convertToNumber(order2.baseAssetAmount)
		);
		console.log(order2);
		const position = clearingHouseUser.getUserAccount().perpPositions[0];
		console.log(
			'curPosition',
			convertToNumber(position.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		assert(order.baseAssetAmountFilled.eq(ZERO));
		assert(order.baseAssetAmount.eq(order2.baseAssetAmount));
		assert(order2.baseAssetAmountFilled.gt(ZERO));
		assert(
			order2.baseAssetAmount
				.sub(order2.baseAssetAmountFilled)
				.add(position.baseAssetAmount.abs())
				.eq(order.baseAssetAmount)
		);

		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openAsks.eq(baseAssetAmount.sub(order2.baseAssetAmountFilled).neg())
		);
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		const amountToFill2 = calculateBaseAssetAmountForAmmToFulfill(
			order2,
			market2,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		assert(amountToFill2.eq(ZERO));

		await clearingHouse.cancelOrder(orderId);
	});

	it('Max leverage fill limit short order', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const limitPrice = calculateReservePrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = new BN(27571723885);

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then short',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		console.log(limitPrice.toString());
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});

		await clearingHouse.placeOrder(orderParams);

		const newPrice = convertToNumber(
			limitPrice.mul(new BN(104)).div(new BN(100)),
			PRICE_PRECISION
		);
		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, newPrice, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newPrice * PRICE_PRECISION.toNumber())
		);

		console.log('user leverage:', convertToNumber(userLeverage0, TEN_THOUSAND));

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);

		const standardizedBaseAssetAmount = standardizeBaseAssetAmount(
			baseAssetAmount,
			clearingHouse.getPerpMarketAccount(marketIndex).amm
				.baseAssetAmountStepSize
		);
		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openAsks.eq(standardizedBaseAssetAmount.neg())
		);
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		console.log(amountToFill);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getPerpMarketAccount(marketIndex);
		const newMarkPrice1 = calculateReservePrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();
		console.log(
			'mark price:',
			convertToNumber(newMarkPrice1, PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);

		// await clearingHouse.closePosition(marketIndex);
	});
	it('When in Max leverage short, fill limit long order to reduce to ZERO', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const limitPrice = calculateReservePrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = prePosition.baseAssetAmount.abs(); //new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});

		try {
			await clearingHouse.placeOrder(orderParams);
		} catch (e) {
			console.error(e);
			throw e;
		}

		const newPrice = convertToNumber(
			limitPrice.mul(new BN(96)).div(new BN(100)),
			PRICE_PRECISION
		);
		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, newPrice, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newPrice * PRICE_PRECISION.toNumber())
		);

		const order = clearingHouseUser.getUserAccount().orders[0];
		console.log(order.status);
		// assert(order.status == OrderStatus.INIT);
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		console.log(amountToFill);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderPriceMove = clearingHouseUser.getUserAccount().orders[0];
		const newMarketPriceMove = clearingHouse.getPerpMarketAccount(marketIndex);
		const newMarkPricePriceMove = calculateReservePrice(newMarketPriceMove);

		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openBids.eq(baseAssetAmount)
		);

		const userLeveragePriceMove = clearingHouseUser.getLeverage();

		console.log(
			'ON PRICE MOVE:\n',
			'mark price:',
			convertToNumber(newMarkPricePriceMove, PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(
				orderPriceMove.baseAssetAmountFilled,
				AMM_RESERVE_PRECISION
			),
			'/',
			convertToNumber(orderPriceMove.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeveragePriceMove, TEN_THOUSAND),
			'\n'
		);

		try {
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				clearingHouseUser.getUserAccount(),
				order
			);
		} catch (e) {
			console.error(e);
			throw e;
		}

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getPerpMarketAccount(marketIndex);
		const newMarkPrice1 = calculateReservePrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();
		const postPosition = clearingHouseUser.getUserPosition(marketIndex);

		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		console.log(
			'FILLED:',
			'position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'mark price:',
			convertToNumber(newMarkPrice1, PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);

		// assert(userNetGain.lte(ZERO)); // ensure no funny business
		assert(userLeverage.eq(ZERO));
		assert(postPosition.baseAssetAmount.eq(ZERO));
		// await clearingHouse.closePosition(marketIndex);
		// await clearingHouse.cancelOrder(orderId);
	});

	it('Max leverage fill limit long order', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getPerpMarketAccount(marketIndex);

		const limitPrice = calculateReservePrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = new BN(37711910000);

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouseUser.fetchAccounts();

		const newPrice = convertToNumber(
			limitPrice.mul(new BN(97)).div(new BN(100)),
			PRICE_PRECISION
		);
		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, newPrice, solUsd);
		try {
			await clearingHouse.moveAmmToPrice(
				marketIndex,
				new BN(newPrice * PRICE_PRECISION.toNumber())
			);
		} catch (e) {
			console.error(e);
		}

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);

		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openBids.eq(baseAssetAmount)
		);

		console.log(amountToFill);

		assert(order.orderId >= 7);
		try {
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				clearingHouseUser.getUserAccount(),
				order
			);
		} catch (e) {
			console.error(e);
		}

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getPerpMarketAccount(marketIndex);
		const newMarkPrice1 = calculateReservePrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();

		// assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'mark price:',
			convertToNumber(newMarkPrice1, PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);

		assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));
	});

	it('When in Max leverage long, fill limit short order to flip to max leverage short', async () => {
		// determining max leverage short is harder than max leverage long
		// (using linear assumptions since it is smaller base amt)

		const userLeverage0 = clearingHouseUser.getLeverage();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);
		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		// const limitPrice = calculateReservePrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = prePosition.baseAssetAmount.abs().mul(new BN(2)); //new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3];
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		// assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});
		try {
			await clearingHouse.placeOrder(orderParams);
		} catch (e) {
			console.error(e);
			throw e;
		}

		// move price to make liquidity for order @ $1.05 (5%)
		// setFeedPrice(anchor.workspace.Pyth, 1.55, solUsd);
		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(1.55 * PRICE_PRECISION.toNumber())
		// );

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouse.getUserAccount().orders[0];
		console.log(order.status);
		// assert(order.status == OrderStatus.INIT);
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);
		console.log(amountToFill.toString());
		console.log(
			clearingHouseUser.getUserPosition(marketIndex).openAsks.toString()
		);

		assert(
			clearingHouseUser
				.getUserPosition(marketIndex)
				.openAsks.eq(baseAssetAmount.neg())
		);
		assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderPriceMove = clearingHouseUser.getUserAccount().orders[0];
		const newMarketPriceMove = clearingHouse.getPerpMarketAccount(marketIndex);
		const newMarkPricePriceMove = calculateReservePrice(newMarketPriceMove);

		const userLeveragePriceMove = clearingHouseUser.getLeverage();

		console.log(
			'ON PRICE MOVE:\n',
			'mark price:',
			convertToNumber(newMarkPricePriceMove, PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(
				orderPriceMove.baseAssetAmountFilled,
				AMM_RESERVE_PRECISION
			),
			'/',
			convertToNumber(orderPriceMove.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeveragePriceMove, TEN_THOUSAND),
			'\n'
		);

		try {
			const txSig = await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				clearingHouseUser.getUserAccount(),
				order
			);
			await printTxLogs(connection, txSig);
		} catch (e) {
			console.error(e);
			throw e;
		}

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getPerpMarketAccount(marketIndex);
		const newMarkPrice1 = calculateReservePrice(newMarket1); // 0 liquidity at current mark price

		const userTC = clearingHouseUser.getTotalCollateral();
		const userTPV = clearingHouseUser.getTotalPerpPositionValue();

		const userLeverage = clearingHouseUser.getLeverage();
		const postPosition = clearingHouseUser.getUserPosition(marketIndex);

		// console.log(
		// 	clearingHouseUser.getUserPosition(marketIndex).openAsks.toString()
		// );
		// assert(clearingHouseUser.getUserPosition(marketIndex).openAsks.eq(ZERO));
		// assert(clearingHouseUser.getUserPosition(marketIndex).openBids.eq(ZERO));

		console.log(
			'FILLED:',
			'position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'mark price:',
			convertToNumber(newMarkPrice1, PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user TC:',
			convertToNumber(userTC, QUOTE_PRECISION),
			'\n',
			'user TPV:',
			convertToNumber(userTPV, QUOTE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);

		try {
			await clearingHouse.closePosition(marketIndex);
		} catch (e) {
			console.error(e);
			throw e;
		}

		assert(userLeverage.gt(new BN(0)));
		assert(postPosition.baseAssetAmount.lt(ZERO));
	});

	it('Base amount unfilled >= step size for tiny trade (LONG BTC)', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		const userTotalCollatearl = clearingHouseUser.getTotalCollateral();

		console.log(
			'user collatearl',
			convertToNumber(userTotalCollatearl),
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getPerpMarketAccount(marketIndexBTC);
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.div(new BN(10000)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3].sub(new BN(100)); // tiny residual liquidity would be remaining if filled up to price

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams({
			marketIndex: marketIndexBTC,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouseUser.fetchAccounts();

		assert(clearingHouseUser.getUserPosition(marketIndexBTC).openAsks.eq(ZERO));
		assert(
			clearingHouseUser
				.getUserPosition(marketIndexBTC)
				.openBids.eq(baseAssetAmount)
		);

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderAfter = clearingHouseUser.getOrder(orderId);
		const baseAssetAmountUnfilled = orderAfter.baseAssetAmount.sub(
			orderAfter.baseAssetAmountFilled
		);
		const stepSize =
			clearingHouse.getPerpMarketAccount(marketIndexBTC).amm
				.baseAssetAmountStepSize;

		assert(baseAssetAmountUnfilled.eq(stepSize));

		await clearingHouse.closePosition(marketIndexBTC);
		await clearingHouse.cancelOrder(orderId);
	});
	it('Base amount unfilled >= step size for tiny trade (SHORT BTC)', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getPerpMarketAccount(marketIndexBTC);
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.div(new BN(10000)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3].add(new BN(100)); // tiny residual liquidity would be remaining if filled up to price

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateReservePrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams({
			marketIndex: marketIndexBTC,
			direction,
			baseAssetAmount,
			price: limitPrice,
		});
		await clearingHouse.placeOrder(orderParams);

		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateBaseAssetAmountForAmmToFulfill(
			order,
			market,
			clearingHouse.getOracleDataForMarket(order.marketIndex),
			0
		);

		assert(
			clearingHouseUser
				.getUserPosition(marketIndexBTC)
				.openAsks.eq(baseAssetAmount.neg())
		);
		assert(clearingHouseUser.getUserPosition(marketIndexBTC).openBids.eq(ZERO));

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderAfter = clearingHouseUser.getOrder(orderId);
		const baseAssetAmountUnfilled = orderAfter.baseAssetAmount.sub(
			orderAfter.baseAssetAmountFilled
		);
		const stepSize =
			clearingHouse.getPerpMarketAccount(marketIndexBTC).amm
				.baseAssetAmountStepSize;

		assert(baseAssetAmountUnfilled.eq(stepSize));

		await clearingHouse.closePosition(marketIndexBTC);
		await clearingHouse.cancelOrder(orderId);
	});

	it('PlaceAndTake LONG Order 100% filled', async () => {
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

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = new BN('1330000').add(PRICE_PRECISION.div(new BN(40)));

		await clearingHouseUser.fetchAccounts();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(prePosition);
		assert(prePosition.baseAssetAmount.eq(ZERO)); // no existing position

		const fillerCollateralBefore =
			fillerClearingHouse.getQuoteAssetTokenAmount();

		const newPrice = convertToNumber(
			price.mul(new BN(96)).div(new BN(100)),
			PRICE_PRECISION
		);
		setFeedPrice(anchor.workspace.Pyth, newPrice, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newPrice * PRICE_PRECISION.toNumber())
		);

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
		});
		const txSig = await clearingHouse.placeAndTake(orderParams);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig
		);
		console.log('placeAndTake compute units', computeUnits[0]);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const postPosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(
			'User position: ',
			convertToNumber(new BN(0), AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);
		assert(postPosition.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

		// zero filler reward
		const fillerReward = fillerCollateralBefore.sub(
			fillerClearingHouse.getQuoteAssetTokenAmount()
		);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(fillerReward.eq(new BN(0)));

		await clearingHouse.closePosition(marketIndex);
	});

	it('Time-based fee reward cap', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.mul(new BN(10000)));
		const triggerPrice = PRICE_PRECISION.div(new BN(1000));
		const triggerCondition = OrderTriggerCondition.ABOVE;

		const orderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
		});

		const placeTxSig = await whaleClearingHouse.placeOrder(orderParams);
		await printTxLogs(connection, placeTxSig);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderIndex = new BN(0);
		const order = whaleUser.getUserAccount().orders[orderIndex.toString()];

		const fillerCollateralBefore =
			fillerClearingHouse.getQuoteAssetTokenAmount();
		const fillerUnsettledPNLBefore =
			fillerClearingHouse.getUserAccount().perpPositions[0].quoteAssetAmount;

		await fillerClearingHouse.triggerOrder(
			whaleAccountPublicKey,
			whaleUser.getUserAccount(),
			order
		);

		await fillerClearingHouse.fillOrder(
			whaleAccountPublicKey,
			whaleUser.getUserAccount(),
			order
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await fillerClearingHouse.settlePNL(
			await fillerClearingHouse.getUserAccountPublicKey(),
			fillerClearingHouse.getUserAccount(),
			marketIndex
		);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const whaleStats = await whaleClearingHouse.getUserStats().getAccount();

		const expectedFillerReward = new BN(2e6 / 100); //1 cent
		const fillerReward = fillerClearingHouse
			.getQuoteAssetTokenAmount()
			.sub(fillerCollateralBefore)
			.add(fillerUser.getUserAccount().perpPositions[0].quoteAssetAmount)
			.sub(fillerUnsettledPNLBefore);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(fillerReward.eq(expectedFillerReward));

		assert(whaleStats.fees.totalFeePaid.gt(fillerReward.mul(new BN(100))));
		// ensure whale fee more than x100 filler
	});

	it('reduce only', async () => {
		const openPositionOrderParams = getMarketOrderParams({
			marketIndex: marketIndexEth,
			direction: PositionDirection.SHORT,
			baseAssetAmount: AMM_RESERVE_PRECISION,
		});
		await clearingHouse.placeAndTake(openPositionOrderParams);
		console.log('1');
		const reduceMarketOrderParams = getMarketOrderParams({
			marketIndex: marketIndexEth,
			direction: PositionDirection.LONG,
			baseAssetAmount: TWO.mul(AMM_RESERVE_PRECISION),
			reduceOnly: true,
		});
		await clearingHouse.placeAndTake(reduceMarketOrderParams);
		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		console.log('2');

		let orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(orderRecord.baseAssetAmountFilled.eq(AMM_RESERVE_PRECISION));
		assert(
			isVariant(clearingHouseUser.getUserAccount().orders[0].status, 'init')
		);

		await clearingHouse.placeAndTake(openPositionOrderParams);
		const reduceLimitOrderParams = getLimitOrderParams({
			marketIndex: marketIndexEth,
			direction: PositionDirection.LONG,
			baseAssetAmount: TWO.mul(AMM_RESERVE_PRECISION),
			price: calculateReservePrice(
				clearingHouse.getPerpMarketAccount(marketIndexEth)
			).add(PRICE_PRECISION.div(new BN(40))),
			reduceOnly: true,
		});
		console.log('3');

		try {
			await clearingHouse.placeAndTake(reduceLimitOrderParams);
		} catch (e) {
			console.error(e);
		}
		console.log('4');

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		console.log('5');

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(orderRecord.baseAssetAmountFilled.eq(AMM_RESERVE_PRECISION));
		assert(
			isVariant(clearingHouseUser.getUserAccount().orders[0].status, 'init')
		);
	});
});
