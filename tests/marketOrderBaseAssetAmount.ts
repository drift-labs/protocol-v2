import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BN,
	BulkAccountLoader,
	getMarketOrderParams,
	OracleSource,
	ZERO,
} from '../sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import { TestClient, PositionDirection, EventSubscriber } from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	initializeQuoteSpotMarket,
	printTxLogs,
} from './testHelpers';

describe('market orders', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

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

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize();
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
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
		await driftClient.placeAndTakePerpOrder(orderParams);
		const txSig = await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		console.log(
			driftClient.getQuoteAssetTokenAmount().toString(),
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString(),
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert(driftClient.getQuoteAssetTokenAmount().eq(new BN(9951998)));
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		console.log(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001))
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-48048002))
		);
		console.log(driftClient.getUserAccount().perpPositions[0].baseAssetAmount);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(48000000000)));
		assert.ok(market.amm.baseAssetAmountLong.eq(new BN(48000000000)));
		assert.ok(market.amm.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.numberOfUsersWithBase === 1);
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
		const txSig = await driftClient.placeAndTakePerpOrder(orderParams);
		await printTxLogs(connection, txSig);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		console.log(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-24000001))
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-24048001))
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
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9927998)));
		assert(
			driftClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(72001))
		);

		const market = driftClient.getPerpMarketAccount(0);
		console.log(market.amm.baseAssetAmountWithAmm.toString());
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(24000000000)));
		assert.ok(market.amm.baseAssetAmountLong.eq(new BN(24000000000)));
		assert.ok(market.amm.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.numberOfUsersWithBase === 1);
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
		await driftClient.placeAndTakePerpOrder(orderParams);
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9879998)));
		assert(
			driftClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(120001))
		);
		console.log(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(24000000))
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(23952000))
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
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-24000000000)));
		assert.ok(market.amm.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.amm.baseAssetAmountShort.eq(new BN(-24000000000)));
		assert.ok(market.numberOfUsersWithBase === 1);
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
		await driftClient.placeAndTakePerpOrder(orderParams);
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		console.log(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(0))
		);
		assert.ok(
			driftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(0))
		);

		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9855998)));
		assert(
			driftClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(144001))
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
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
