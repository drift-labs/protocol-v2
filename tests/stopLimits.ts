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
	Wallet,
	OrderRecord,
	OrderAction,
	getMarketOrderParams,
	OrderTriggerCondition,
	OrderStatus,
	OrderType,
	getTriggerLimitOrderParams,
} from '../sdk/src';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { AMM_RESERVE_PRECISION, ZERO } from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('stop limit', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

	let userAccountPublicKey: PublicKey;
	let userOrdersAccountPublicKey: PublicKey;

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
			chProgram.programId
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
			chProgram.programId
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
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
	});

	it('Fill stop limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = MARK_PRICE_PRECISION;
		const limitPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.ABOVE;

		await clearingHouse.placeAndFillOrder(
			getMarketOrderParams(
				marketIndex,
				PositionDirection.LONG,
				ZERO,
				baseAssetAmount,
				false
			)
		);

		const orderParams = getTriggerLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			triggerPrice,
			triggerCondition,
			false,
			true
		);

		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);
		const orderId = new BN(2);
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
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[3];
		const expectedRecordId = new BN(4);
		const expectedOrderId = new BN(2);
		const expectedTradeRecordId = new BN(2);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(enumsAreEqual(orderRecord.order.orderType, OrderType.TRIGGER_LIMIT));
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

	it('Fill stop limit long order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = MARK_PRICE_PRECISION;
		const limitPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.BELOW;

		await clearingHouse.placeAndFillOrder(
			getMarketOrderParams(
				marketIndex,
				PositionDirection.SHORT,
				ZERO,
				baseAssetAmount,
				false
			)
		);

		const orderParams = getTriggerLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			triggerPrice,
			triggerCondition,
			false,
			true
		);

		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);
		const orderId = new BN(4);
		const orderIndex = new BN(0);
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
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[3];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(999999);
		assert.ok(
			tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount)
		);
		assert.ok(tradeHistoryRecord.markPriceBefore.lt(triggerPrice));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[7];
		const expectedRecordId = new BN(8);
		const expectedOrderId = new BN(4);
		const expectedTradeRecordId = new BN(4);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(enumsAreEqual(orderRecord.order.orderType, OrderType.TRIGGER_LIMIT));
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
});
