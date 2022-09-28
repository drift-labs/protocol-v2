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
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
} from './testHelpers';
import { BASE_PRECISION, OracleSource } from '../sdk';

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
		spotMarketIndexes = [0, 1];
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
		await initializeSolSpotMarket(fillerClearingHouse, solUsd);
		await fillerClearingHouse.updateSpotAuctionDuration(0);

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

	it('trigger order with below condition', async () => {
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

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await clearingHouse.placeSpotOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		let order = clearingHouseUser.getOrderByUserOrderId(1);

		const newOraclePrice = 0.49;
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerSpotOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		await fillerClearingHouse.fetchAccounts();

		order = clearingHouseUser.getOrderByUserOrderId(1);
		assert(order.triggered);

		const userQuoteTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		assert(userQuoteTokenAmount.eq(new BN(9990000)));
		const fillerQuoteTokenAmount =
			fillerClearingHouse.getQuoteAssetTokenAmount();
		assert(fillerQuoteTokenAmount.eq(new BN(10010000)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('trigger order with above condition', async () => {
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

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.mul(new BN(2)),
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await clearingHouse.placeSpotOrder(stopOrderParams);

		await clearingHouseUser.fetchAccounts();
		let order = clearingHouseUser.getOrderByUserOrderId(1);

		const newOraclePrice = 2.01;
		await setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);

		await fillerClearingHouse.triggerSpotOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		await fillerClearingHouse.fetchAccounts();

		order = clearingHouseUser.getOrderByUserOrderId(1);
		assert(order.triggered);

		const userQuoteTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		assert(userQuoteTokenAmount.eq(new BN(9990000)));
		const fillerQuoteTokenAmount =
			fillerClearingHouse.getQuoteAssetTokenAmount();
		assert(fillerQuoteTokenAmount.eq(new BN(10020000)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
