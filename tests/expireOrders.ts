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

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	getLimitOrderParams,
	isVariant,
	QUOTE_PRECISION,
} from '../sdk';

describe('expire order', () => {
	const provider = anchor.Provider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

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

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

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
		await clearingHouse.subscribeToAll();
		solUsd = await mockOracle(0);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();

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

	it('Open and cancel orders', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION;

		const orderParams = getLimitOrderParams(
			new BN(0),
			direction,
			baseAssetAmount,
			price,
			false
		);

		for (let i = 0; i < 32; i++) {
			await clearingHouse.placeOrder(orderParams);
		}

		await clearingHouse.fetchAccounts();
		let orderHistory = clearingHouse.getOrderHistoryAccount();
		for (let i = 0; i < 32; i++) {
			const orderRecord = orderHistory.orderRecords[i];
			assert(isVariant(orderRecord.action, 'place'));
		}

		try {
			await fillerClearingHouse.expireOrders(
				await clearingHouse.getUserAccountPublicKey(),
				await clearingHouse.getUserOrdersAccountPublicKey()
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await clearingHouse.withdrawCollateral(
			usdcAmount.sub(QUOTE_PRECISION),
			userUSDCAccount.publicKey
		);
		await fillerClearingHouse.expireOrders(
			await clearingHouse.getUserAccountPublicKey(),
			await clearingHouse.getUserOrdersAccountPublicKey()
		);

		await clearingHouse.fetchAccounts();
		await fillerClearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();
		orderHistory = clearingHouse.getOrderHistoryAccount();
		for (let i = 32; i < 64; i++) {
			const orderRecord = orderHistory.orderRecords[i];
			assert(isVariant(orderRecord.action, 'expire'));
		}

		assert(clearingHouseUser.getUserAccount().collateral.eq(new BN(990000)));
		assert(fillerUser.getUserAccount().collateral.eq(new BN(10010000)));

		try {
			await fillerClearingHouse.expireOrders(
				await clearingHouse.getUserAccountPublicKey(),
				await clearingHouse.getUserOrdersAccountPublicKey()
			);
			assert(false);
		} catch (e) {
			// no op
		}
	});
});
