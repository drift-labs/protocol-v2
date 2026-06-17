import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, OracleSource, ZERO } from '../packages/sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import { TestClient, PositionDirection, EventSubscriber } from '../packages/sdk/src';

import {
	getProtocolFeeTotal,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('market orders', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

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
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection,
			chProgram
		);
		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }];

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await velocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		[, userAccountPublicKey] =
			await velocityClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await velocityClient.unsubscribe();
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
		await velocityClient.placeAndTakePerpOrder(orderParams);
		const txSig = await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);
		bankrunContextWrapper.printTxLogs(txSig);

		console.log(
			velocityClient.getQuoteAssetTokenAmount().toString(),
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString(),
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9951998)));
		assert(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001))
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-48048002))
		);
		console.log(
			velocityClient.getUserAccount().perpPositions[0].baseAssetAmount
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(48000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(48000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.numberOfUsersWithBase === 1);
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(48001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(48001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

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
		const txSig = await velocityClient.placeAndTakePerpOrder(orderParams);
		bankrunContextWrapper.printTxLogs(txSig);

		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(-24000001))
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-24048001))
		);
		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toNumber()
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(24000000000))
		);

		console.log(velocityClient.getQuoteAssetTokenAmount().toString());
		assert.ok(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9927998)));
		assert(
			velocityClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(72001))
		);

		const market = velocityClient.getPerpMarketAccount(0);
		console.log(market.amm.baseAssetAmountWithAmm.toString());
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(24000000000)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(24000000000)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.numberOfUsersWithBase === 1);
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(72001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(72001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

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
		await velocityClient.placeAndTakePerpOrder(orderParams);
		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		await velocityClient.fetchAccounts();
		console.log(velocityClient.getQuoteAssetTokenAmount().toString());
		assert.ok(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9879998)));
		assert(
			velocityClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(120001))
		);
		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteEntryAmount.eq(new BN(24000000))
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(23952000))
		);
		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.toString()
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(-24000000000))
		);

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-24000000000)));
		assert.ok(market.baseAssetAmountLong.eq(ZERO));
		assert.ok(market.baseAssetAmountShort.eq(new BN(-24000000000)));
		assert.ok(market.numberOfUsersWithBase === 1);
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(120001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(120001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

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
		await velocityClient.placeAndTakePerpOrder(orderParams);
		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.toString()
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteBreakEvenAmount.eq(new BN(0))
		);
		assert.ok(
			velocityClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(0))
		);

		console.log(velocityClient.getQuoteAssetTokenAmount().toString());
		assert.ok(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9855998)));
		assert(
			velocityClient
				.getUserStats()
				.getAccount()
				.fees.totalFeePaid.eq(new BN(144001))
		);

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(144001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(144001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(4)));
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderRecord.marketIndex === 0);
	});
});
