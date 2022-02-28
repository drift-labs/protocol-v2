import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, ONE, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	calculateTradeSlippage,
	PositionDirection,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockUSDCMint, mockUserUSDCAccount, mockOracle } from './testHelpers';

describe('clearing_house', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

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

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Long from 0 position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885);
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(orderParams);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert(user.collateral.eq(new BN(9950250)));
		assert(user.totalFeePaid.eq(new BN(49750)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(49750001))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount);
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();

		const market = marketsAccount.markets[0];
		console.log(market.baseAssetAmount.toNumber());

		assert.ok(market.baseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(497450503674885)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(49750)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].recordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[0].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].baseAssetAmount.eq(
				new BN(497450503674885)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[0].quoteAssetAmount.eq(new BN(49750001))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[0].marketIndex.eq(marketIndex));
	});

	it('Order fails due to unrealiziable limit price ', async () => {
		// Should be a better a way to catch an exception with chai but wasn't working for me
		try {
			const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
			const marketIndex = new BN(0);
			const market = clearingHouse.getMarket(marketIndex);
			const estTradePrice = calculateTradeSlippage(
				PositionDirection.SHORT,
				newUSDCNotionalAmount,
				market
			)[2];

			// trying to sell at price too high
			const limitPriceTooHigh = calculateMarkPrice(market);
			console.log(
				'failed order:',
				estTradePrice.toNumber(),
				limitPriceTooHigh.toNumber()
			);

			const baseAssetAmount = new BN(497450503674885).div(new BN(2));
			const orderParams = getMarketOrderParams(
				marketIndex,
				PositionDirection.SHORT,
				ZERO,
				baseAssetAmount,
				false,
				limitPriceTooHigh
			);
			await clearingHouse.placeAndFillOrder(orderParams);
		} catch (e) {
			assert(true);
			return;
		}

		assert(false, 'Order succeeded');
	});

	it('Reduce long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885).div(new BN(2));
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(orderParams);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(24875001))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount.toNumber());
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(248725251837443)
			)
		);
		console.log(user.collateral.toString());
		console.log(user.totalFeePaid.toString());
		assert.ok(user.collateral.eq(new BN(9926611)));
		assert(user.totalFeePaid.eq(new BN(74626)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		console.log(market.baseAssetAmount.toString());
		assert.ok(market.baseAssetAmount.eq(new BN(248725251837443)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(248725251837443)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(74626)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(74626)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 2);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].recordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[1].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeHistoryAccount.tradeRecords[1].baseAssetAmount.toNumber());
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].baseAssetAmount.eq(
				new BN(248725251837442)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[1].quoteAssetAmount.eq(new BN(24876237))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[1].marketIndex.eq(new BN(0)));
	});

	it('Reverse long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885);
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);
		await clearingHouse.placeAndFillOrder(orderParams);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);

		assert.ok(user.collateral.eq(new BN(9875627)));
		assert(user.totalFeePaid.eq(new BN(124371)));
		assert.ok(
			userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(24871287))
		);
		console.log(userPositionsAccount.positions[0].baseAssetAmount.toString());
		assert.ok(
			userPositionsAccount.positions[0].baseAssetAmount.eq(
				new BN(-248725251837442)
			)
		);

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(-248725251837442)));
		assert.ok(market.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.baseAssetAmountShort.eq(new BN(-248725251837442)));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(124371)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(124371)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 3);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].recordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[2].direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeHistoryAccount.tradeRecords[2].baseAssetAmount.toNumber());
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].baseAssetAmount.eq(
				new BN(497450503674885)
			)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[2].quoteAssetAmount.eq(new BN(49745049))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].marketIndex.eq(new BN(0)));
	});

	it('Close position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(248725251837442);
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			true
		);
		await clearingHouse.placeAndFillOrder(orderParams);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		const userPositionsAccount: any =
			await clearingHouse.program.account.userPositions.fetch(user.positions);
		assert.ok(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
		assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(user.collateral.eq(new BN(9850755)));
		assert(user.totalFeePaid.eq(new BN(149242)));

		const marketsAccount = clearingHouse.getMarketsAccount();
		const market: any = marketsAccount.markets[0];
		assert.ok(market.baseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(149242)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(149242)));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

		assert.ok(tradeHistoryAccount.head.toNumber() === 4);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].user.equals(userAccountPublicKey)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[3].recordId.eq(new BN(4)));
		assert.ok(
			JSON.stringify(tradeHistoryAccount.tradeRecords[3].direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].baseAssetAmount.eq(
				new BN(248725251837442)
			)
		);
		assert.ok(tradeHistoryAccount.tradeRecords[2].liquidation == false);
		assert.ok(
			tradeHistoryAccount.tradeRecords[3].quoteAssetAmount.eq(new BN(24871288))
		);
		assert.ok(tradeHistoryAccount.tradeRecords[3].marketIndex.eq(new BN(0)));
	});
});
