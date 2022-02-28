import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	getUserOrdersAccountPublicKey,
	ClearingHouseUser,
	OrderStatus,
	OrderDiscountTier,
	OrderRecord,
	OrderAction,
	OrderTriggerCondition,
	calculateTargetPriceTrade,
	convertToNumber,
	QUOTE_PRECISION,
	Wallet,
	calculateTradeSlippage,
	getLimitOrderParams,
	getTriggerMarketOrderParams,
} from '../sdk/src';

import { calculateAmountToTradeForLimit } from '../sdk/src/orders';

import {
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateMarkPrice,
	findComputeUnitConsumption,
	TEN_THOUSAND,
	ZERO,
} from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('orders', () => {
	const provider = anchor.Provider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

	let userAccountPublicKey: PublicKey;
	let userOrdersAccountPublicKey: PublicKey;

	let whaleAccountPublicKey: PublicKey;
	let whaleOrdersAccountPublicKey: PublicKey;

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

	const whaleKeyPair = new Keypair();
	const usdcAmountWhale = new BN(10000000 * 10 ** 6);
	let whaleUSDCAccount: Keypair;
	let whaleClearingHouse: ClearingHouse;
	let whaleUser: ClearingHouseUser;

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

	const marketIndex = new BN(1);
	const marketIndexBTC = new BN(2);

	let solUsd;
	let btcUsd;

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
		await clearingHouse.subscribeToAll();
		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeMarket(
			marketIndexBTC,
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000000) // btc-ish price level
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			clearingHouse.program.programId,
			userAccountPublicKey
		);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();

		discountMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await clearingHouse.updateDiscountMint(discountMint.publicKey);

		discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(fillerKeyPair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await fillerClearingHouse.subscribe();

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = ClearingHouseUser.from(
			fillerClearingHouse,
			fillerKeyPair.publicKey
		);
		await fillerUser.subscribe();

		provider.connection.requestAirdrop(whaleKeyPair.publicKey, 10 ** 9);
		whaleUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmountWhale,
			provider,
			whaleKeyPair.publicKey
		);
		whaleClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(whaleKeyPair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await whaleClearingHouse.subscribe();

		[, whaleAccountPublicKey] =
			await whaleClearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmountWhale,
				whaleUSDCAccount.publicKey
			);

		whaleUser = ClearingHouseUser.from(
			whaleClearingHouse,
			whaleKeyPair.publicKey
		);
		whaleOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			clearingHouse.program.programId,
			whaleAccountPublicKey
		);
		await whaleUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await fillerUser.unsubscribe();

		await whaleClearingHouse.unsubscribe();
		await whaleUser.unsubscribe();
	});

	it('Open long limit order', async () => {
		// user has $10, no open positions, trading in market of $1 mark price coin
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = true;
		const triggerPrice = new BN(0);

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			true
		);
		// user sets reduce-only taker limit buy @ $2
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const expectedOrderId = new BN(1);

		assert(order.baseAssetAmount.eq(baseAssetAmount));
		assert(order.price.eq(price));
		assert(order.triggerPrice.eq(triggerPrice));
		assert(order.marketIndex.eq(marketIndex));
		assert(order.reduceOnly === reduceOnly);
		assert(enumsAreEqual(order.direction, direction));
		assert(enumsAreEqual(order.status, OrderStatus.OPEN));
		assert(enumsAreEqual(order.discountTier, OrderDiscountTier.FOURTH));
		assert(order.orderId.eq(expectedOrderId));
		assert(order.ts.gt(ZERO));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const position = userPositionsAccount.positions[0];
		const expectedOpenOrders = new BN(1);
		assert(position.openOrders.eq(expectedOpenOrders));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[0];
		const expectedRecordId = new BN(1);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.PLACE));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
	});

	it('Fail to fill reduce only order', async () => {
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];

		try {
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				userOrdersAccountPublicKey,
				order
			);
		} catch (e) {
			return;
		}

		assert(false);
	});

	it('Cancel order', async () => {
		const orderIndex = new BN(0);
		const orderId = new BN(1);
		await clearingHouse.cancelOrder(orderId);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const order =
			clearingHouseUser.getUserOrdersAccount().orders[orderIndex.toNumber()];

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const position = userPositionsAccount.positions[0];
		const expectedOpenOrders = new BN(0);
		assert(position.openOrders.eq(expectedOpenOrders));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[1];
		const expectedRecordId = new BN(2);
		const expectedOrderId = new BN(1);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.CANCEL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
	});

	it('Fill limit long order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);
		const orderIndex = new BN(0);
		const orderId = new BN(2);
		await clearingHouseUser.fetchAccounts();
		let order = clearingHouseUser.getOrder(orderId);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		order = userOrdersAccount.orders[orderIndex.toString()];

		const fillerUserAccount = fillerUser.getUserAccount();
		const expectedFillerReward = new BN(95);
		console.log(
			'FillerReward: $',
			convertToNumber(
				fillerUserAccount.collateral.sub(usdcAmount),
				QUOTE_PRECISION
			)
		);
		assert(
			fillerUserAccount.collateral.sub(usdcAmount).eq(expectedFillerReward)
		);

		const market = clearingHouse.getMarket(marketIndex);
		const expectedFeeToMarket = new BN(855);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(50);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const firstPosition = userPositionsAccount.positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		const expectedQuoteAssetAmount = new BN(1000003);
		// console.log(convertToNumber(firstPosition.quoteAssetAmount, QUOTE_PRECISION),
		//  '!=',
		//  convertToNumber(expectedQuoteAssetAmount, QUOTE_PRECISION),
		//  );
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[0];

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[3];
		const expectedRecordId = new BN(4);
		const expectedOrderId = new BN(2);
		const expectedTradeRecordId = new BN(1);
		const expectedFee = new BN(950);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert(orderRecord.fillerReward.eq(expectedFillerReward));
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Fill stop short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.ABOVE;

		const orderParams = getTriggerMarketOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);
		const orderId = new BN(3);
		const orderIndex = new BN(0);
		await clearingHouseUser.fetchAccounts();
		let order = clearingHouseUser.getOrder(orderId);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		order = userOrdersAccount.orders[orderIndex.toString()];

		const fillerUserAccount = fillerUser.getUserAccount();
		const expectedFillerReward = new BN(190);
		console.log(
			'FillerReward: $',
			convertToNumber(
				fillerUserAccount.collateral.sub(usdcAmount),
				QUOTE_PRECISION
			)
		);
		assert(
			fillerUserAccount.collateral.sub(usdcAmount).eq(expectedFillerReward)
		);

		const market = clearingHouse.getMarket(marketIndex);
		const expectedFeeToMarket = new BN(1710);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(100);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const firstPosition = userPositionsAccount.positions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[1];

		assert.ok(tradeHistoryAccount.head.toNumber() === 2);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(1000002);
		assert.ok(
			tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount)
		);
		assert.ok(tradeHistoryRecord.markPriceBefore.gt(triggerPrice));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[5];
		const expectedRecordId = new BN(6);
		const expectedOrderId = new BN(3);
		const expectedTradeRecordId = new BN(2);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(
			orderRecord.quoteAssetAmountFilled.eq(expectedTradeQuoteAssetAmount)
		);
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Fail to fill limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouse.fetchAccounts();
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		assert(amountToFill.eq(ZERO));

		console.log(amountToFill);

		const orderId = new BN(4);
		try {
			await clearingHouseUser.fetchAccounts();
			const order = clearingHouseUser.getOrder(orderId);
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				userOrdersAccountPublicKey,
				order
			);
			await clearingHouse.cancelOrder(orderId);
		} catch (e) {
			await clearingHouse.cancelOrder(orderId);
			return;
		}

		assert(false);
	});

	it('Partial fill limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market).sub(new BN(10000)); // 0 liquidity at current mark price
		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(!amountToPrice.eq(ZERO));
		assert(newDirection == direction);

		console.log(
			convertToNumber(calculateMarkPrice(market)),
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
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);

		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouseUser.fetchAccounts();
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		const orderId = new BN(5);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const market2 = clearingHouse.getMarket(marketIndex);
		const userOrdersAccount2 = clearingHouseUser.getUserOrdersAccount();
		const order2 = userOrdersAccount2.orders[0];
		console.log(
			'order filled: ',
			convertToNumber(order.baseAssetAmount),
			'->',
			convertToNumber(order2.baseAssetAmount)
		);
		console.log(order2);
		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const position = userPositionsAccount.positions[0];
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

		const amountToFill2 = calculateAmountToTradeForLimit(market2, order2);
		assert(amountToFill2.eq(ZERO));

		const userAccount = clearingHouseUser.getUserAccount();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);

		assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
		);

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

		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
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

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 1.45, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.45 * MARK_PRICE_PRECISION.toNumber())
		);

		await clearingHouseUser.fetchAccounts();
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccount1 = clearingHouseUser.getUserOrdersAccount();
		const order1 = userOrdersAccount1.orders[0];
		const newMarket1 = clearingHouse.getMarket(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userAccount = clearingHouseUser.getUserAccount();
		const userLeverage = clearingHouseUser.getLeverage();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);

		assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n',
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
		);
		// await clearingHouse.closePosition(marketIndex);
		await clearingHouse.cancelOrder(orderId);
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

		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = prePosition.baseAssetAmount.abs(); //new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
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
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);

		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 1.35, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.35 * MARK_PRICE_PRECISION.toNumber())
		);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		console.log(order.status);
		// assert(order.status == OrderStatus.INIT);
		const amountToFill = calculateAmountToTradeForLimit(market, order);
		console.log(amountToFill);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccountPriceMove = clearingHouseUser.getUserOrdersAccount();
		const orderPriceMove = userOrdersAccountPriceMove.orders[0];
		const newMarketPriceMove = clearingHouse.getMarket(marketIndex);
		const newMarkPricePriceMove = calculateMarkPrice(newMarketPriceMove);

		const userAccountPriceMove = clearingHouseUser.getUserAccount();
		const userLeveragePriceMove = clearingHouseUser.getLeverage();
		const userNetGainPriceMove = clearingHouseUser
			.getTotalCollateral()
			.add(userAccountPriceMove.totalFeePaid)
			.sub(userAccountPriceMove.cumulativeDeposits);

		console.log(
			'ON PRICE MOVE:\n',
			'mark price:',
			convertToNumber(newMarkPricePriceMove, MARK_PRICE_PRECISION),
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
			'\n',
			'user net gain:',
			convertToNumber(userNetGainPriceMove, QUOTE_PRECISION)
		);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccount1 = clearingHouseUser.getUserOrdersAccount();
		const order1 = userOrdersAccount1.orders[0];
		const newMarket1 = clearingHouse.getMarket(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userAccount = clearingHouseUser.getUserAccount();
		const userLeverage = clearingHouseUser.getLeverage();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);
		const postPosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'FILLED:',
			'position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n',
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
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
		const totalCol = clearingHouseUser.getTotalCollateral();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = AMM_RESERVE_PRECISION.mul(
			totalCol.mul(new BN(5)).div(QUOTE_PRECISION)
		);
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
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
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 1.33, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.33 * MARK_PRICE_PRECISION.toNumber())
		);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		const orderId = order.orderId;
		assert(order.orderId.gte(new BN(7)));
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccount1 = clearingHouseUser.getUserOrdersAccount();
		const order1 = userOrdersAccount1.orders[0];
		const newMarket1 = clearingHouse.getMarket(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userAccount = clearingHouseUser.getUserAccount();
		const userLeverage = clearingHouseUser.getLeverage();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);

		// assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n',
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
		);
		// await clearingHouse.closePosition(marketIndex);
		await clearingHouse.cancelOrder(orderId);
	});

	it('When in Max leverage long, fill limit long order to flip to max leverage short', async () => {
		// determining max leverage short is harder than max leverage long
		// (using linear assumptions since it is smaller base amt)

		const userLeverage0 = clearingHouseUser.getLeverage();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getMarket(marketIndex);
		// const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
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
			convertToNumber(calculateMarkPrice(market)),
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
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		// setFeedPrice(anchor.workspace.Pyth, 1.55, solUsd);
		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(1.55 * MARK_PRICE_PRECISION.toNumber())
		// );

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		console.log(order.status);
		// assert(order.status == OrderStatus.INIT);
		const amountToFill = calculateAmountToTradeForLimit(market, order);
		console.log(amountToFill);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccountPriceMove = clearingHouseUser.getUserOrdersAccount();
		const orderPriceMove = userOrdersAccountPriceMove.orders[0];
		const newMarketPriceMove = clearingHouse.getMarket(marketIndex);
		const newMarkPricePriceMove = calculateMarkPrice(newMarketPriceMove);

		const userAccountPriceMove = clearingHouseUser.getUserAccount();
		const userLeveragePriceMove = clearingHouseUser.getLeverage();
		const userNetGainPriceMove = clearingHouseUser
			.getTotalCollateral()
			.add(userAccountPriceMove.totalFeePaid)
			.sub(userAccountPriceMove.cumulativeDeposits);

		console.log(
			'ON PRICE MOVE:\n',
			'mark price:',
			convertToNumber(newMarkPricePriceMove, MARK_PRICE_PRECISION),
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
			'\n',
			'user net gain:',
			convertToNumber(userNetGainPriceMove, QUOTE_PRECISION)
		);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const userOrdersAccount1 = clearingHouseUser.getUserOrdersAccount();
		const order1 = userOrdersAccount1.orders[0];
		const newMarket1 = clearingHouse.getMarket(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userAccount = clearingHouseUser.getUserAccount();
		const userLeverage = clearingHouseUser.getLeverage();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);
		const postPosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'FILLED:',
			'position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n',
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
		);
		await clearingHouse.closePosition(marketIndex);
		await clearingHouse.cancelOrder(order.orderId);

		assert(userLeverage.gt(new BN(0)));
		assert(postPosition.baseAssetAmount.lt(ZERO));
	});

	it('Round up when residual base_asset_fill left is <= minimum tick size (LONG BTC)', async () => {
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

		const market = clearingHouse.getMarket(marketIndexBTC);
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.div(new BN(10000)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3].sub(new BN(1000)); // tiny residual liquidity would be remaining if filled up to price

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateMarkPrice(market)),
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
		const orderParams = getLimitOrderParams(
			marketIndexBTC,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouseUser.fetchAccounts();

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));

		const prePosition = clearingHouseUser.getUserPosition(marketIndexBTC);

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const newMarket1 = clearingHouse.getMarket(marketIndexBTC);
		const newMarkPrice1 = calculateMarkPrice(newMarket1);

		const postPosition = clearingHouseUser.getUserPosition(marketIndexBTC);
		console.log(
			'User position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		console.log(
			'assert: ',
			convertToNumber(newMarkPrice1),
			'<',
			convertToNumber(limitPrice)
		);
		assert(newMarkPrice1.gt(limitPrice)); // rounded up long pushes price slightly above limit
		assert(
			postPosition.baseAssetAmount.abs().gt(prePosition.baseAssetAmount.abs())
		);
		await clearingHouse.closePosition(marketIndexBTC);

		// ensure order no longer exists
		try {
			await clearingHouse.cancelOrder(orderId);
		} catch (e) {
			return;
		}

		assert(false);
	});
	it('Round up when residual base_asset_fill left is <= minimum tick size (SHORT BTC)', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getMarket(marketIndexBTC);
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.div(new BN(10000)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3].add(new BN(1000)); // tiny residual liquidity would be remaining if filled up to price

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateMarkPrice(market)),
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
		const orderParams = getLimitOrderParams(
			marketIndexBTC,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouseUser.fetchAccounts();

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));

		const prePosition = clearingHouseUser.getUserPosition(marketIndexBTC);

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const newMarket1 = clearingHouse.getMarket(marketIndexBTC);
		const newMarkPrice1 = calculateMarkPrice(newMarket1);
		console.log(
			'assert: ',
			convertToNumber(newMarkPrice1),
			'>',
			convertToNumber(limitPrice)
		);
		assert(newMarkPrice1.lt(limitPrice)); // rounded up long pushes price slightly above limit

		const postPosition = clearingHouseUser.getUserPosition(marketIndexBTC);
		console.log(
			'User position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);
		assert(
			postPosition.baseAssetAmount.abs().gt(prePosition.baseAssetAmount.abs())
		);

		await clearingHouse.closePosition(marketIndexBTC);

		// ensure order no longer exists
		try {
			await clearingHouse.cancelOrder(orderId);
		} catch (e) {
			return;
		}

		assert(false);
	});

	it('PlaceAndFill LONG Order 100% filled', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));

		const prePosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(prePosition);
		assert(prePosition == undefined); // no existing position

		const fillerUserAccount0 = fillerUser.getUserAccount();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			true
		);
		const txSig = await clearingHouse.placeAndFillOrder(
			orderParams,
			discountTokenAccount.address
		);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig
		);
		console.log('placeAndFill compute units', computeUnits[0]);

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
		assert(postPosition.baseAssetAmount.abs().gt(new BN(0)));
		assert(postPosition.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

		// zero filler reward
		const fillerUserAccount = fillerUser.getUserAccount();
		const fillerReward = fillerUserAccount0.collateral.sub(
			fillerUserAccount.collateral
		);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(fillerReward.eq(new BN(0)));

		await clearingHouse.closePosition(marketIndex);
	});

	it('PlaceAndFill LONG Order multiple fills', async () => {
		// todo: check order/trade account history and make sure they match expectations
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[2]; // set entryPrice as limit

		const prePosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(prePosition.baseAssetAmount.toString());
		// assert(prePosition==undefined); // no existing position

		const fillerUserAccount0 = fillerUser.getUserAccount();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeAndFillOrder(
			orderParams,
			discountTokenAccount.address
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
		assert(postPosition.baseAssetAmount.abs().gt(new BN(0)));

		// fill again

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));
		const market2 = clearingHouse.getMarket(marketIndex);

		const markPrice2 = calculateMarkPrice(market2);
		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 0.7, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(0.7 * MARK_PRICE_PRECISION.toNumber())
		);
		const market3 = clearingHouse.getMarket(marketIndex);

		const markPrice3 = calculateMarkPrice(market3);
		console.log(
			'Market Price:',
			convertToNumber(markPrice2),
			'->',
			convertToNumber(markPrice3)
		);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			order
		);

		await clearingHouseUser.fetchAccounts();
		const postPosition2 = clearingHouseUser.getUserPosition(marketIndex);
		console.log(
			'Filler: User position: ',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition2.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		assert(postPosition2.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

		// other part filler reward
		const fillerUserAccount = fillerUser.getUserAccount();
		const fillerReward = fillerUserAccount.collateral.sub(
			fillerUserAccount0.collateral
		);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(fillerReward.gt(new BN(0)));
		await clearingHouse.closePosition(marketIndex);
	});

	it('Block whale trade > reserves', async () => {
		const direction = PositionDirection.SHORT;

		// whale trade
		const baseAssetAmount = new BN(
			AMM_RESERVE_PRECISION.mul(usdcAmountWhale).div(QUOTE_PRECISION)
		);
		const triggerPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.ABOVE;

		const orderParams = getTriggerMarketOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
			false,
			false
		);
		await whaleClearingHouse.placeOrder(orderParams);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderIndex = new BN(0);
		const userOrdersAccount = whaleUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[orderIndex.toString()];
		try {
			await whaleClearingHouse.fillOrder(
				whaleAccountPublicKey,
				whaleOrdersAccountPublicKey,
				order
			);
		} catch (e) {
			await whaleClearingHouse.cancelOrder(order.orderId);
			return;
		}

		assert(false);
	});

	it('Time-based fee reward cap', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.mul(new BN(10000)));
		const market0 = clearingHouse.getMarket(marketIndex);
		const triggerPrice = calculateMarkPrice(market0).sub(new BN(1));
		const triggerCondition = OrderTriggerCondition.ABOVE;

		const orderParams = getTriggerMarketOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
			false,
			false
		);
		await whaleClearingHouse.placeOrder(orderParams);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderIndex = new BN(0);
		const userOrdersAccount = whaleUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[orderIndex.toString()];
		const fillerUserAccountBefore = fillerUser.getUserAccount();

		await fillerClearingHouse.fillOrder(
			whaleAccountPublicKey,
			whaleOrdersAccountPublicKey,
			order
		);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const whaleUserAccount = whaleUser.getUserAccount();
		console.log(
			'whaleFee:',
			convertToNumber(whaleUserAccount.totalFeePaid, QUOTE_PRECISION)
		);

		const fillerUserAccount = fillerUser.getUserAccount();
		const expectedFillerReward = new BN(1e6 / 100); //1 cent
		const fillerReward = fillerUserAccount.collateral.sub(
			fillerUserAccountBefore.collateral
		);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(
			fillerUserAccount.collateral
				.sub(fillerUserAccountBefore.collateral)
				.eq(expectedFillerReward)
		);

		assert(whaleUserAccount.totalFeePaid.gt(fillerReward.mul(new BN(100))));
		// ensure whale fee more than x100 filler
	});
});
