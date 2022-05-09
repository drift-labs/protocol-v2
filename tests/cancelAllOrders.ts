import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ClearingHouseUser,
	AMM_RESERVE_PRECISION,
	convertToNumber,
	getLimitOrderParams,
	isVariant,
	PEG_PRECISION,
} from '../sdk';

describe('cancel all orders', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
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
	let btcUsd;

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
		solUsd = await mockOracle(1);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		btcUsd = await mockOracle(40000);
		await clearingHouse.initializeMarket(
			new BN(1),
			btcUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(40000 * PEG_PRECISION.toNumber())
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

	it('Open and cancel subsets of orders', async () => {
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

		for (let i = 0; i < 3; i++) {
			await clearingHouse.placeOrder(orderParams);
		}

		const orderParams2 = getLimitOrderParams(
			new BN(0),
			PositionDirection.SHORT,
			baseAssetAmount,
			price.mul(new BN(2)),
			false
		);

		for (let i = 0; i < 3; i++) {
			await clearingHouse.placeOrder(orderParams2);
		}

		// add market 1 post only sells
		const orderParams3 = getLimitOrderParams(
			new BN(1),
			PositionDirection.SHORT,
			baseAssetAmount.div(new BN(10000)),
			price.mul(new BN(40001)),
			false,
			undefined,
			undefined,
			undefined,
			true
		);
		await clearingHouse.placeOrder(orderParams3);
		const orderParams4 = getLimitOrderParams(
			new BN(1),
			PositionDirection.SHORT,
			baseAssetAmount.div(new BN(10000)),
			price.mul(new BN(40002)),
			false,
			undefined,
			undefined,
			undefined,
			true
		);
		await clearingHouse.placeOrder(orderParams4);

		await clearingHouse.fetchAccounts();
		let orderHistory = clearingHouse.getOrderHistoryAccount();
		for (let i = 64; i < 64 + 8; i++) {
			const orderRecord = orderHistory.orderRecords[i];
			assert(isVariant(orderRecord.action, 'place'));
		}

		const markets = clearingHouse.getMarketsAccount();
		const oracles = clearingHouseUser
			.getUserPositionsAccount()
			.positions.map((position) => {
				return markets.markets[position.marketIndex.toString()].amm.oracle;
			});

		// cancel market_index=0, longs
		await clearingHouse.cancelOrdersByMarketAndSide(
			oracles,
			true,
			new BN(0),
			PositionDirection.LONG
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		orderHistory = clearingHouse.getOrderHistoryAccount();
		for (let i = 64 + 8; i < 64 + 8 + 3; i++) {
			const orderRecord = orderHistory.orderRecords[i];
			assert(isVariant(orderRecord.action, 'cancel'));
		}

		const orderAccount = clearingHouseUser.getUserOrdersAccount();
		let count = 0;
		for (const order of orderAccount.orders) {
			if (!isVariant(order.status, 'init') && order.marketIndex.eq(new BN(0))) {
				assert(isVariant(order.status, 'open'));
				assert(isVariant(order.direction, 'short'));
				count += 1;
			}
		}
		assert(count == 3);

		await clearingHouse.moveAmmToPrice(
			new BN(1),
			new BN(40001.5 * MARK_PRICE_PRECISION.toNumber())
		);

		// cancel market_index=1, shorts (best effort!)
		await clearingHouse.cancelOrdersByMarketAndSide(
			oracles,
			true,
			new BN(1),
			PositionDirection.SHORT
		);

		const orderAccount2 = clearingHouseUser.getUserOrdersAccount();
		let count2 = 0;
		for (const order of orderAccount2.orders) {
			if (!isVariant(order.status, 'init') && order.marketIndex.eq(new BN(1))) {
				console.log(convertToNumber(order.price));
				assert(isVariant(order.status, 'open'));
				assert(isVariant(order.direction, 'short'));
				count2 += 1;
			}
		}
		assert(count2 == 1);
	});
});
