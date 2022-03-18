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
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	BASE_PRECISION,
	calculateMarkPrice,
	getLimitOrderParams,
	isVariant,
	ZERO,
} from '../sdk';

describe('maker order', () => {
	const provider = anchor.Provider.local(undefined, {
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

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		fillerClearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
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

	it('long', async () => {
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
			}
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
		const markPrice = calculateMarkPrice(clearingHouse.getMarket(marketIndex));
		const makerOrderParams = getLimitOrderParams(
			marketIndex,
			PositionDirection.LONG,
			baseAssetAmount,
			markPrice,
			false,
			false,
			false,
			1,
			true
		);
		await clearingHouse.placeOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.mul(new BN(2)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);
		await setFeedPrice(anchor.workspace.Pyth, 0.5, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		assert(position.quoteAssetAmount.eq(new BN(1000000)));

		await fillerClearingHouse.fetchAccounts();
		const orderHistory = fillerClearingHouse.getOrderHistoryAccount();
		const orderRecord = orderHistory.orderRecords[1];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.fee.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(499999)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('short', async () => {
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
			}
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
		const markPrice = calculateMarkPrice(clearingHouse.getMarket(marketIndex));
		const makerOrderParams = getLimitOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			baseAssetAmount,
			markPrice,
			false,
			false,
			false,
			1,
			true
		);
		await clearingHouse.placeOrder(makerOrderParams);
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		await fillerClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(2)),
			ammInitialQuoteAssetReserve,
			marketIndex
		);

		await setFeedPrice(anchor.workspace.Pyth, 2, solUsd);

		await fillerClearingHouse.fillOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			await clearingHouseUser.getUserOrdersAccountPublicKey(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		assert(position.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(position.quoteAssetAmount.eq(new BN(1000000)));

		await fillerClearingHouse.fetchAccounts();
		const orderHistory = fillerClearingHouse.getOrderHistoryAccount();
		const orderRecord = orderHistory.orderRecords[3];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.fee.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(999992)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
