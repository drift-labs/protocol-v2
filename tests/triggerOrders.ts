import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	getMarketOrderParams,
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
	getTriggerLimitOrderParams,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import { BASE_PRECISION, ZERO } from '../sdk';

describe('trigger orders', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let fillerClearingHouse: Admin;
	let fillerClearingHouseUser: ClearingHouseUser;

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

		fillerClearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await fillerClearingHouse.initialize(usdcMint.publicKey, true);
		await fillerClearingHouse.subscribeToAll();
		solUsd = await mockOracle(1);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerClearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerClearingHouseUser = ClearingHouseUser.from(
			fillerClearingHouse,
			provider.wallet.publicKey
		);
		await fillerClearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			ZERO
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await fillerClearingHouse.unsubscribe();
		await fillerClearingHouseUser.unsubscribe();
	});

	it('stop market for long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			baseAssetAmount,
			MARK_PRICE_PRECISION.div(new BN(2)),
			OrderTriggerCondition.BELOW,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(10)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.1, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('stop limit for long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopLimitOrderParams = getTriggerLimitOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			baseAssetAmount,
			MARK_PRICE_PRECISION.div(new BN(10)),
			MARK_PRICE_PRECISION.div(new BN(2)),
			OrderTriggerCondition.BELOW,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(5)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.2, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('stop market for short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			baseAssetAmount,
			MARK_PRICE_PRECISION.mul(new BN(2)),
			OrderTriggerCondition.ABOVE,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(10)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 10, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('stop limit for short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopLimitOrderParams = getTriggerLimitOrderParams(
			marketIndex,
			PositionDirection.LONG,
			baseAssetAmount,
			MARK_PRICE_PRECISION.mul(new BN(10)),
			MARK_PRICE_PRECISION.mul(new BN(2)),
			OrderTriggerCondition.ABOVE,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(5)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 5, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('take profit for long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			baseAssetAmount,
			MARK_PRICE_PRECISION.mul(new BN(2)),
			OrderTriggerCondition.ABOVE,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(10)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 10, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('take profit limit for long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopLimitOrderParams = getTriggerLimitOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			baseAssetAmount,
			MARK_PRICE_PRECISION.mul(new BN(2)),
			MARK_PRICE_PRECISION.mul(new BN(2)),
			OrderTriggerCondition.ABOVE,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(5)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 5, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('take profit for short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			baseAssetAmount,
			MARK_PRICE_PRECISION.div(new BN(2)),
			OrderTriggerCondition.BELOW,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(10)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.1, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('take profit limit for short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			keypair.publicKey
		);
		await clearingHouseUser.subscribe();

		const marketIndex = new BN(0);
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(marketOrderParams);

		const stopLimitOrderParams = getTriggerLimitOrderParams(
			marketIndex,
			PositionDirection.LONG,
			baseAssetAmount,
			MARK_PRICE_PRECISION.div(new BN(2)),
			MARK_PRICE_PRECISION.div(new BN(2)),
			OrderTriggerCondition.BELOW,
			false,
			undefined,
			undefined,
			1
		);
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				await clearingHouseUser.getUserOrdersAccountPublicKey(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(5)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.2, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
