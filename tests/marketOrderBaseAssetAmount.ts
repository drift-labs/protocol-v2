import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, ONE, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { AdminClient, PositionDirection, EventSubscriber } from '../sdk/src';

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
	const driftProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, driftProgram);
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

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		[, userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await driftClient.unsubscribe();
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
		await driftClient.placeAndTake(orderParams);
		const txSig = await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		assert(driftClient.getQuoteAssetTokenAmount().eq(new BN(9951999)));
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48000))
		);

		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001))
		);
		console.log(driftClient.getUserAccount().perpPositions[0].baseAssetAmount);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(48000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(48000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(48000)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(48000)));

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
		const txSig = await driftClient.placeAndTake(orderParams);
		await printTxLogs(connection, txSig);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-24000001))
		);
		console.log(
			driftClient.getUserAccount().perpPositions[0].baseAssetAmount.toNumber()
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(24000000000))
		);

		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9927999)));
		assert(
			driftClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(72000))
		);

		const market = driftClient.getPerpMarketAccount(0);
		console.log(market.amm.netBaseAssetAmount.toString());
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(24000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(24000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(72000)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(72000)));

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
		await driftClient.placeAndTake(orderParams);
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9879999)));
		assert(
			driftClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(120000))
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(24000000))
		);
		console.log(
			driftClient.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(-24000000000))
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-24000000000)));
		assert.ok(market.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.baseAssetAmountShort.eq(new BN(-24000000000)));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.eq(new BN(120000)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(120000)));

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
		await driftClient.placeAndTake(orderParams);
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(0))
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(0))
		);

		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9855999)));
		assert(
			driftClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(144000))
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(144000)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(144000)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(4)));
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderRecord.marketIndex === 0);
	});
});
