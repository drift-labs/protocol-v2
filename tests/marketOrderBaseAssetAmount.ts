import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, ONE, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { Admin, PositionDirection, EventSubscriber } from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	initializeQuoteSpotMarket,
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
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const solUsd = await mockOracle(1);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		clearingHouse = new Admin({
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
			userStats: true,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

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
		const marketIndex = 0;
		const baseAssetAmount = new BN(48000000000);
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

		console.log(
			clearingHouse.getQuoteAssetTokenAmount().toString(),
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString(),
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.toString()
		);
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9951998)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001))
		);
		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const market = clearingHouse.getPerpMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(48000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(48000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(48001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(48001)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(1)));
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(48000001)));
		assert.ok(orderRecord.marketIndex === marketIndex);
	});

	it('Reduce long position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = new BN(24000000000);
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
				.perpPositions[0].quoteEntryAmount.eq(new BN(-24000001))
		);
		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount.toNumber()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(24000000000))
		);

		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9927998)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(72001))
		);

		const market = clearingHouse.getPerpMarketAccount(0);
		console.log(market.amm.netBaseAssetAmount.toString());
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(24000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(24000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(72001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(72001)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(2)));
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderRecord.marketIndex === 0);
	});

	it('Reverse long position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = new BN(48000000000);
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

		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9879998)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(120001))
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(24000000))
		);
		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(-24000000000))
		);

		const market = clearingHouse.getPerpMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-24000000000)));
		assert.ok(market.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.baseAssetAmountShort.eq(new BN(-24000000000)));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(120001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(120001)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(3)));
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		console.log(orderRecord.quoteAssetAmountFilled.toString());
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(48000000)));
		assert.ok(orderRecord.marketIndex === 0);
	});

	it('Close position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = new BN(24000000000);
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
			clearingHouse
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(0))
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(0))
		);

		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9855998)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(144001))
		);

		const market = clearingHouse.getPerpMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(144001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(144001)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(4)));
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderRecord.marketIndex === 0);
	});
});
