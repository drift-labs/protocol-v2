import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ClearingHouseUser,
} from '../sdk/src';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { AMM_RESERVE_PRECISION, getLimitOrderParams, isVariant } from '../sdk';

describe('cancel all orders', () => {
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
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
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

		const markets = clearingHouse.getMarketsAccount();
		const oracles = clearingHouseUser
			.getUserPositionsAccount()
			.positions.map((position) => {
				return markets.markets[position.marketIndex.toString()].amm.oracle;
			});
		await clearingHouse.cancelAllOrders(oracles);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		orderHistory = clearingHouse.getOrderHistoryAccount();
		for (let i = 32; i < 64; i++) {
			const orderRecord = orderHistory.orderRecords[i];
			assert(isVariant(orderRecord.action, 'cancel'));
		}

		const orderAccount = clearingHouseUser.getUserOrdersAccount();
		for (const order of orderAccount.orders) {
			assert(isVariant(order.status, 'init'));
		}
	});
});
