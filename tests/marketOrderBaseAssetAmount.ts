import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, ONE, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	initializeQuoteAssetBank,
	printTxLogs,
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

	let marketIndexes;
	let bankIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const solUsd = await mockOracle(1);
		marketIndexes = [new BN(0)];
		bankIndexes = [new BN(0)];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
			userStats: true,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

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
		const baseAssetAmount = new BN(480000000000000);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(orderParams);
		const txSig = await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9947387)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48004))
		);

		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteEntryAmount.eq(new BN(-48004609))
		);
		console.log(clearingHouse.getUserAccount().positions[0].baseAssetAmount);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(480000000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(480000000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(48004)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(48004)));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(480000000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(48004609)));
		assert.ok(orderRecord.marketIndex.eq(marketIndex));
	});

	it('Reduce long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(240000000000000);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		const txSig = await clearingHouse.placeAndTake(orderParams);
		await printTxLogs(connection, txSig);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteEntryAmount.eq(new BN(-24002305))
		);
		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toNumber()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(new BN(240000000000000))
		);

		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9926840)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(72007))
		);

		const market = clearingHouse.getMarketAccount(0);
		console.log(market.amm.netBaseAssetAmount.toString());
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(240000000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(240000000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(72007)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(72007)));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(240000000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24003456)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Reverse long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(480000000000000);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await clearingHouse.placeAndTake(orderParams);
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9878840)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(120007))
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteEntryAmount.eq(new BN(24000000))
		);
		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toString()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(new BN(-240000000000000))
		);

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-240000000000000)));
		assert.ok(market.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.baseAssetAmountShort.eq(new BN(-240000000000000)));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(120007)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(120007)));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(480000000000000)));
		console.log(orderRecord.quoteAssetAmountFilled.toString());
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(48000000)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Close position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(240000000000000);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			reduceOnly: true,
		});
		await clearingHouse.placeAndTake(orderParams);
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		assert.ok(
			clearingHouse.getUserAccount().positions[0].quoteEntryAmount.eq(new BN(0))
		);
		assert.ok(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.eq(new BN(0))
		);

		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9855993)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(144005))
		);

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(144005)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(144005)));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(4)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(240000000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(23998849)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});
});
