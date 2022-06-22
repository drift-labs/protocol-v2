import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { assert } from 'chai';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	getLimitOrderParams,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateEntryPrice,
	OracleSource,
	ZERO,
} from '../sdk';

describe('oracle offset', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
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

	let marketIndexes;
	let bankIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		marketIndexes = [new BN(0)];
		bankIndexes = [new BN(0)];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerClearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await fillerClearingHouse.initialize(usdcMint.publicKey, true);
		await fillerClearingHouse.subscribe();
		await initializeQuoteAssetBank(fillerClearingHouse, usdcMint.publicKey);

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

	it('long taker', async () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
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

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = ZERO;
		const reduceOnly = false;
		const priceOffset = MARK_PRICE_PRECISION.div(new BN(20)).neg();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			undefined,
			undefined,
			1,
			undefined,
			priceOffset
		);
		await clearingHouse.placeOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		assert(entryPrice.eq(new BN(9090930000)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('long maker', async () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
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

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = MARK_PRICE_PRECISION.div(new BN(20)).neg();
		const price = MARK_PRICE_PRECISION.add(priceOffset);

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			undefined,
			undefined,
			1,
			true,
			priceOffset
		);
		await clearingHouse.placeOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		const expectedEntryPrice = new BN(9500010000);
		assert(entryPrice.eq(expectedEntryPrice));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('short taker', async () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
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

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = ZERO;
		const reduceOnly = false;
		const priceOffset = MARK_PRICE_PRECISION.div(new BN(20));

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			undefined,
			undefined,
			1,
			undefined,
			priceOffset
		);
		await clearingHouse.placeOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10)),
			marketIndex
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		assert(entryPrice.eq(new BN(10999970000)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('short maker', async () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
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

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = MARK_PRICE_PRECISION.div(new BN(20));
		const price = MARK_PRICE_PRECISION.add(priceOffset);

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			undefined,
			undefined,
			1,
			true,
			priceOffset
		);
		await clearingHouse.placeOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10)),
			marketIndex
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		const expectedEntryPrice = MARK_PRICE_PRECISION.add(priceOffset);
		assert(entryPrice.eq(expectedEntryPrice));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('cancel by order id', async () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
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

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = MARK_PRICE_PRECISION.div(new BN(20));
		const price = MARK_PRICE_PRECISION.add(priceOffset);

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			undefined,
			undefined,
			undefined,
			true,
			priceOffset
		);
		await clearingHouse.placeOrder(orderParams);

		await clearingHouseUser.fetchAccounts();
		const orderId = clearingHouseUser.getUserAccount().orders[0].orderId;
		await clearingHouse.cancelOrder(orderId);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('cancel by user order id', async () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
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

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = MARK_PRICE_PRECISION.div(new BN(20));
		const price = MARK_PRICE_PRECISION.add(priceOffset);

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			undefined,
			undefined,
			1,
			true,
			priceOffset
		);
		await clearingHouse.placeOrder(orderParams);

		await clearingHouseUser.fetchAccounts();
		await clearingHouse.cancelOrderByUserId(1);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
