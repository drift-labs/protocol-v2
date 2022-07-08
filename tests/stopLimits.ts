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
	ClearingHouseUser,
	Wallet,
	OrderRecord,
	OrderAction,
	getMarketOrderParams,
	OrderTriggerCondition,
	OrderStatus,
	OrderType,
	getTriggerLimitOrderParams,
	EventSubscriber,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { AMM_RESERVE_PRECISION, OracleSource, ZERO } from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('stop limit', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

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

	const marketIndex = new BN(0);
	let solUsd;
	let btcUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);

		const marketIndexes = [marketIndex];
		const bankIndexes = [new BN(0)];
		const oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH,
			},
			{
				publicKey: btcUsd,
				source: OracleSource.PYTH,
			},
		];

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
		await clearingHouse.updateOrderAuctionTime(new BN(0));

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
			new BN(60000000) // btc-ish price level
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
		fillerClearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(fillerKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
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
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
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
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		order = clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryRecord = eventSubscriber.getEventsArray('TradeRecord')[0];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(1000002);
		assert.ok(
			tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount)
		);
		assert.ok(tradeHistoryRecord.markPriceBefore.gt(triggerPrice));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		const expectedOrderId = new BN(2);
		const expectedTradeRecordId = new BN(2);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(enumsAreEqual(orderRecord.order.orderType, OrderType.TRIGGER_LIMIT));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(
			orderRecord.authority.equals(clearingHouseUser.getUserAccount().authority)
		);
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
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		order = clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryRecord = eventSubscriber.getEventsArray('TradeRecord')[0];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(999999);
		assert.ok(
			tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount)
		);
		assert.ok(tradeHistoryRecord.markPriceBefore.lt(triggerPrice));

		const orderRecord: OrderRecord =
			eventSubscriber.getEventsArray('OrderRecord')[0];
		const expectedOrderId = new BN(4);
		const expectedTradeRecordId = new BN(4);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(enumsAreEqual(orderRecord.order.orderType, OrderType.TRIGGER_LIMIT));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(
			orderRecord.authority.equals(clearingHouseUser.getUserAccount().authority)
		);
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
