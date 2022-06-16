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
	EventSubscriber,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	initializeQuoteAssetBank,
} from './testHelpers';

describe('clearing_house', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

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
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
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
		await eventSubscriber.unsubscribe();
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

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9950250)));
		assert(user.totalFeePaid.eq(new BN(49750)));

		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteAssetAmount.eq(new BN(49750001))
		);
		console.log(clearingHouse.getUserAccount().positions[0].baseAssetAmount);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(497450503674885)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(49750)));

		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;
		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(tradeRecord.liquidation == false);
		assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(49750001)));
		assert.ok(tradeRecord.marketIndex.eq(marketIndex));
	});

	it('Order fails due to unrealiziable limit price ', async () => {
		// Should be a better a way to catch an exception with chai but wasn't working for me
		try {
			const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
			const marketIndex = new BN(0);
			const market = clearingHouse.getMarketAccount(marketIndex);
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
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteAssetAmount.eq(new BN(24875001))
		);
		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toNumber()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(new BN(248725251837443))
		);
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9926611)));
		assert(user.totalFeePaid.eq(new BN(74626)));

		const market = clearingHouse.getMarketAccount(0);
		console.log(market.amm.netBaseAssetAmount.toString());
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(248725251837443)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(248725251837443)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(74626)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(74626)));

		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeRecord.baseAssetAmount.toNumber());
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(248725251837442)));
		assert.ok(tradeRecord.liquidation == false);
		assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(24876237)));
		assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
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

		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9875627)));
		assert(user.totalFeePaid.eq(new BN(124371)));
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteAssetAmount.eq(new BN(24871287))
		);
		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toString()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(new BN(-248725251837442))
		);

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-248725251837442)));
		assert.ok(market.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.baseAssetAmountShort.eq(new BN(-248725251837442)));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(124371)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(124371)));

		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeRecord.baseAssetAmount.toNumber());
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(49745049)));
		assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
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

		assert.ok(
			clearingHouse.getUserAccount().positions[0].quoteAssetAmount.eq(new BN(0))
		);
		assert.ok(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.eq(new BN(0))
		);
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9850755)));
		assert(user.totalFeePaid.eq(new BN(149242)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(149242)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(149242)));

		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(4)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(248725251837442)));
		assert.ok(tradeRecord.liquidation == false);
		assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(24871288)));
		assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
	});
});
