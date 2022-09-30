import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	PRICE_PRECISION,
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
	initializeQuoteSpotMarket,
} from './testHelpers';
import {
	BASE_PRECISION,
	convertToNumber,
	OracleSource,
	QUOTE_PRECISION,
	ZERO,
} from '../sdk';

describe('trigger orders', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let fillerClearingHouse: Admin;
	let fillerClearingHouseUser: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let solUsd;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH,
			},
		];

		fillerClearingHouse = new Admin({
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
		await fillerClearingHouse.initialize(usdcMint.publicKey, true);
		await fillerClearingHouse.subscribe();
		await initializeQuoteSpotMarket(fillerClearingHouse, usdcMint.publicKey);
		await fillerClearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerClearingHouseUser = new ClearingHouseUser({
			clearingHouse: fillerClearingHouse,
			userAccountPublicKey: await fillerClearingHouse.getUserAccountPublicKey(),
		});
		await fillerClearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await fillerClearingHouse.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 0.49;
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: PRICE_PRECISION.div(new BN(2)).sub(
				PRICE_PRECISION.div(new BN(50))
			),
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 0.49;
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.mul(new BN(2)),
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 2.01;
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const triggerPrice = PRICE_PRECISION.mul(new BN(6)).div(new BN(5));
		const limitPrice = triggerPrice.add(PRICE_PRECISION.div(new BN(50)));
		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice,
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await clearingHouseUser.fetchAccounts();

		const totalCollateral0 = clearingHouseUser.getTotalCollateral();
		console.log(
			'user total collateral 0:',
			convertToNumber(totalCollateral0, QUOTE_PRECISION)
		);

		const newOraclePrice = 1.201;
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await clearingHouseUser.fetchAccounts();

		const totalCollateral = clearingHouseUser.getTotalCollateral();
		console.log(
			'user total collateral after:',
			convertToNumber(totalCollateral, QUOTE_PRECISION)
		);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		// await printTxLogs(connection, txSig);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.mul(new BN(2)),
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.div(new BN(10)),
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 2.01, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const triggerPrice = PRICE_PRECISION.mul(new BN(2));
		const limitPrice = triggerPrice.sub(PRICE_PRECISION.div(new BN(50)));
		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice: triggerPrice,
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 2.01;
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerClearingHouse.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(10)),
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.49, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
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
		const clearingHouse = new ClearingHouse({
			connection,
			wallet: wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(marketOrderParams);

		const triggerPrice = PRICE_PRECISION.div(new BN(2));
		const limitPrice = triggerPrice.add(PRICE_PRECISION.div(new BN(50)));
		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice: triggerPrice,
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await clearingHouse.placeOrder(stopLimitOrderParams);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerClearingHouse.fillOrder(
				await clearingHouseUser.getUserAccountPublicKey(),
				clearingHouseUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 0.49;
		await fillerClearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);
		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();

		assert(
			clearingHouseUser
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
