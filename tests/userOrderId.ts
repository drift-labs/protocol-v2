import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	PositionDirection,
	getUserOrdersAccountPublicKey,
	ClearingHouseUser,
	getLimitOrderParams,
} from '../sdk/src';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { AMM_RESERVE_PRECISION } from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('user order id', () => {
	const provider = anchor.Provider.local();
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

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

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

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await getUserOrdersAccountPublicKey(
			clearingHouse.program.programId,
			await clearingHouse.getUserAccountPublicKey()
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
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('place order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = true;
		const userOrderId = 1;

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			false,
			false,
			userOrderId
		);
		await clearingHouse.placeOrder(orderParams);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];

		assert(order.userOrderId === userOrderId);
	});

	it('fail to place same user id twice', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = true;
		const userOrderId = 1;

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			false,
			false,
			userOrderId
		);
		try {
			await clearingHouse.placeOrder(orderParams);
		} catch (_) {
			//
			return;
		}
		assert(false);
	});

	it('cancel ', async () => {
		await clearingHouse.cancelOrderByUserId(1);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];

		assert(order.userOrderId === 0);
	});
});
