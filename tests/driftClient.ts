import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	isVariant,
	PerpMarketAccount,
	OracleSource,
	ZERO,
	BulkAccountLoader,
} from '../sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey, TransactionSignature } from '@solana/web3.js';

import {
	TestClient,
	calculateTradeSlippage,
	PositionDirection,
	getPerpMarketPublicKey,
	EventSubscriber,
	QUOTE_SPOT_MARKET_INDEX,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	setFeedPrice,
	initializeQuoteSpotMarket,
	getTokenAmountAsBN,
	mintUSDCToUser,
	printTxLogs,
	sleep,
} from './testHelpers';
import { getAccount } from '@solana/spl-token';

describe('drift client', () => {
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

	let solUsd;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
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

		solUsd = await mockOracle(1);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize State', async () => {
		await driftClient.initialize();

		await driftClient.subscribe();
		const state = driftClient.getStateAccount();
		await driftClient.updatePerpAuctionDuration(new BN(0));

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const expectedSigner = driftClient.getSignerPublicKey();
		assert(state.signer.equals(expectedSigner));

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR

		const marketIndex = 0;
		const txSig = await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const marketPublicKey = await getPerpMarketPublicKey(
			driftClient.program.programId,
			marketIndex
		);
		const market = (await driftClient.program.account.perpMarket.fetch(
			marketPublicKey
		)) as PerpMarketAccount;

		assert.ok(JSON.stringify(market.status) === JSON.stringify({ active: {} }));
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
		assert.ok(market.numberOfUsersWithBase === 0);

		const ammD = market.amm;
		console.log(ammD.oracle.toString());
		assert.ok(ammD.oracle.equals(solUsd));
		assert.ok(ammD.baseAssetReserve.eq(ammInitialBaseAssetAmount));
		assert.ok(ammD.quoteAssetReserve.eq(ammInitialQuoteAssetAmount));
		assert.ok(ammD.cumulativeFundingRateLong.eq(new BN(0)));
		assert.ok(ammD.cumulativeFundingRateShort.eq(new BN(0)));
		assert.ok(ammD.fundingPeriod.eq(periodicity));
		assert.ok(ammD.lastFundingRate.eq(new BN(0)));
		assert.ok(!ammD.lastFundingRateTs.eq(new BN(0)));
		assert.ok(!ammD.historicalOracleData.lastOraclePriceTwapTs.eq(new BN(0)));
	});

	it('Initialize user account and deposit collateral atomically', async () => {
		let txSig: TransactionSignature;
		[txSig, userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
		const depositTokenAmount = driftClient.getQuoteAssetTokenAmount();
		assert(depositTokenAmount.eq(usdcAmount));
		assert(
			isVariant(
				driftClient.getSpotPosition(QUOTE_SPOT_MARKET_INDEX).balanceType,
				'deposit'
			)
		);

		// Check that drift collateral account has proper collateral
		const quoteSpotVault = await getAccount(
			connection,
			driftClient.getQuoteSpotMarketAccount().vault
		);
		assert.ok(new BN(quoteSpotVault.amount).eq(usdcAmount));

		assert.ok(user.perpPositions.length == 8);
		assert.ok(user.perpPositions[0].baseAssetAmount.toNumber() === 0);
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.toNumber() === 0);
		assert.ok(user.perpPositions[0].lastCumulativeFundingRate.toNumber() === 0);

		await eventSubscriber.awaitTx(txSig);
		const depositRecord = eventSubscriber.getEventsArray('DepositRecord')[0];

		assert.ok(depositRecord.userAuthority.equals(provider.wallet.publicKey));
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ deposit: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
	});

	it('Withdraw Collateral', async () => {
		const txSig = await driftClient.withdraw(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey,
			true
		);

		await driftClient.fetchAccounts();
		assert(driftClient.getQuoteAssetTokenAmount().eq(ZERO));

		// Check that drift collateral account has proper collateral]
		const quoteSpotVaultAmount = await getTokenAmountAsBN(
			connection,
			driftClient.getQuoteSpotMarketAccount().vault
		);
		assert.ok(quoteSpotVaultAmount.eq(ZERO));

		const userUSDCtoken = await getTokenAmountAsBN(
			connection,
			userUSDCAccount.publicKey
		);
		assert.ok(userUSDCtoken.eq(usdcAmount));

		await eventSubscriber.awaitTx(txSig);
		const depositRecord = eventSubscriber.getEventsArray('DepositRecord')[0];

		assert.ok(depositRecord.userAuthority.equals(provider.wallet.publicKey));
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ withdraw: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
	});

	it('Long from 0 position', async () => {
		// Re-Deposit USDC, assuming we have 0 balance here
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const baseAssetAmount = new BN(48000000000);
		const txSig = await driftClient.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);
		await printTxLogs(connection, txSig);
		const marketData = driftClient.getPerpMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.01, marketData.amm.oracle);

		await eventSubscriber.awaitTx(txSig);
		const orderR = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		console.log(orderR.takerFee.toString());
		console.log(orderR.baseAssetAmountFilled.toString());

		const txSigSettlePnl = await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSigSettlePnl);

		const user: any = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);

		console.log(
			'getQuoteAssetTokenAmount:',
			driftClient.getQuoteAssetTokenAmount().toString()
		);
		assert(driftClient.getQuoteAssetTokenAmount().eq(new BN(10000000)));
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-48048002)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(48000000000)));

		const market = driftClient.getPerpMarketAccount(0);
		console.log(market.amm.baseAssetAmountWithAmm.toNumber());
		console.log(market);

		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(48000000000)));
		console.log(market.amm.totalFee.toString());
		assert.ok(market.amm.totalFee.eq(new BN(48001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(48001)));

		await eventSubscriber.awaitTx(txSig);
		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(1)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(48000001)));
		assert.ok(orderActionRecord.marketIndex === marketIndex);

		assert(driftClient.getPerpMarketAccount(0).nextFillRecordId.eq(new BN(2)));
	});

	it('Withdraw fails due to insufficient collateral', async () => {
		// lil hack to stop printing errors
		const oldConsoleLog = console.log;
		const oldConsoleError = console.error;
		console.log = function () {
			const _noop = '';
		};
		console.error = function () {
			const _noop = '';
		};
		try {
			await driftClient.withdraw(
				usdcAmount,
				QUOTE_SPOT_MARKET_INDEX,
				userUSDCAccount.publicKey
			);
			assert(false, 'Withdrawal succeeded');
		} catch (e) {
			assert(true);
		} finally {
			console.log = oldConsoleLog;
			console.error = oldConsoleError;
		}
	});

	it('Reduce long position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = new BN(24000000000);
		const txSig = await driftClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex
		);

		await driftClient.fetchAccounts();

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		await driftClient.fetchAccounts();
		const user = driftClient.getUserAccount();
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteBreakEvenAmount:',
			user.perpPositions[0].quoteBreakEvenAmount.toNumber()
		);

		assert.ok(user.perpPositions[0].quoteAssetAmount.eq(new BN(-24072002)));
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(-24000001)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-24048001)));

		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(24000000000)));
		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(10000000)));
		console.log(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(72001))
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(24000000000)));
		assert.ok(market.amm.totalFee.eq(new BN(72001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(72001)));

		await eventSubscriber.awaitTx(txSig);
		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(2)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderActionRecord.marketIndex === 0);
	});

	it('Reverse long position', async () => {
		const marketData = driftClient.getPerpMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.0, marketData.amm.oracle);

		const baseAssetAmount = new BN(48000000000);
		const txSig = await driftClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			0
		);

		await driftClient.fetchAccounts();
		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);

		await driftClient.fetchAccounts();
		const user = driftClient.getUserAccount();
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteBreakEvenAmount:',
			user.perpPositions[0].quoteBreakEvenAmount.toNumber()
		);
		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		console.log(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9879998)));
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(120001))
		);
		console.log(user.perpPositions[0].quoteBreakEvenAmount.toString());
		console.log(user.perpPositions[0].quoteAssetAmount.toString());

		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(24000000)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(23952000)));
		assert.ok(user.perpPositions[0].quoteAssetAmount.eq(new BN(24000000)));
		console.log(user.perpPositions[0].baseAssetAmount.toString());
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(-24000000000)));

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-24000000000)));
		assert.ok(market.amm.totalFee.eq(new BN(120001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(120001)));

		await eventSubscriber.awaitTx(txSig);
		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(3)));
		console.log(orderActionRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(48000000)));

		assert.ok(orderActionRecord.marketIndex === 0);
	});

	it('Close position', async () => {
		const marketIndex = 0;
		const txSig = await driftClient.closePosition(marketIndex);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);

		const user: any = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(0)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		console.log(driftClient.getQuoteAssetTokenAmount().toString());
		assert.ok(driftClient.getQuoteAssetTokenAmount().eq(new BN(9855998)));
		console.log(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(144001))
		);

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(144001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(144001)));

		await eventSubscriber.awaitTx(txSig);
		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(4)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderActionRecord.marketIndex === 0);
	});

	it('Open short position', async () => {
		const baseAssetAmount = new BN(48000000000);
		const txSig = await driftClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			0
		);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);

		const user = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);
		console.log(user.perpPositions[0].quoteBreakEvenAmount.toString());
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(47999999)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(47951999)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(-48000000000)));

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-48000000000)));

		await eventSubscriber.awaitTx(txSig);
		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(5)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(47999999)));
		assert.ok(orderActionRecord.marketIndex === 0);
	});

	it('Trade small size position', async () => {
		await mintUSDCToUser(
			usdcMint,
			userUSDCAccount.publicKey,
			usdcAmount,
			provider
		);

		await sleep(2000);

		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		try {
			await driftClient.openPosition(
				PositionDirection.LONG,
				driftClient.getPerpMarketAccount(0).amm.orderStepSize,
				0
			);
		} catch (e) {
			console.log(e);
		}
	});

	it('Short order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = 0;
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const estTradePrice = calculateTradeSlippage(
			PositionDirection.SHORT,
			baseAssetAmount,
			market,
			'base',
			undefined,
			true
		)[2];

		await driftClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex,
			estTradePrice
		);

		await driftClient.fetchAccounts();

		await driftClient.closePosition(marketIndex);
	});

	it('Long order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = 0;
		const market = driftClient.getPerpMarketAccount(marketIndex);
		const estTradePrice = calculateTradeSlippage(
			PositionDirection.LONG,
			baseAssetAmount,
			market,
			'base'
		)[2];

		await driftClient.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex,
			estTradePrice.add(market.amm.orderTickSize)
		);

		await driftClient.fetchAccounts();

		await driftClient.closePosition(marketIndex);
	});
});
