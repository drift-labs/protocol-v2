import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	isVariant,
	PerpMarketAccount,
	OracleSource,
	ZERO,
} from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey, TransactionSignature } from '@solana/web3.js';

import {
	Admin,
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

		clearingHouse = new Admin({
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
		});
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize State', async () => {
		await clearingHouse.initialize(usdcMint.publicKey, true);

		await clearingHouse.subscribe();
		const state = clearingHouse.getStateAccount();
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const expectedSigner = clearingHouse.getSignerPublicKey();
		assert(state.signer.equals(expectedSigner));

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR

		const marketIndex = 0;
		const txSig = await clearingHouse.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		await clearingHouse.updatePerpMarketStepSizeAndTickSize(
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
			clearingHouse.program.programId,
			marketIndex
		);
		const market = (await clearingHouse.program.account.perpMarket.fetch(
			marketPublicKey
		)) as PerpMarketAccount;

		assert.ok(JSON.stringify(market.status) === JSON.stringify({ active: {} }));
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
		assert.ok(market.numberOfUsers === 0);

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
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
		const depositTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		assert(depositTokenAmount.eq(usdcAmount));
		assert(
			isVariant(
				clearingHouse.getSpotPosition(QUOTE_SPOT_MARKET_INDEX).balanceType,
				'deposit'
			)
		);

		// Check that clearing house collateral account has proper collateral
		const quoteSpotVault = await getTokenAccount(
			provider,
			clearingHouse.getQuoteSpotMarketAccount().vault
		);
		assert.ok(quoteSpotVault.amount.eq(usdcAmount));

		assert.ok(user.perpPositions.length == 8);
		assert.ok(user.perpPositions[0].baseAssetAmount.toNumber() === 0);
		assert.ok(user.perpPositions[0].quoteEntryAmount.toNumber() === 0);
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
		const txSig = await clearingHouse.withdraw(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey,
			true
		);

		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(ZERO));

		// Check that clearing house collateral account has proper collateral]
		const quoteSpotVaultAmount = await getTokenAmountAsBN(
			connection,
			clearingHouse.getQuoteSpotMarketAccount().vault
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
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const baseAssetAmount = new BN(48000000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);
		await printTxLogs(connection, txSig);
		const marketData = clearingHouse.getPerpMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.01, marketData.amm.oracle);

		await eventSubscriber.awaitTx(txSig);
		const orderR = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		console.log(orderR.takerFee.toString());
		console.log(orderR.baseAssetAmountFilled.toString());

		const txSigSettlePnl = await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSigSettlePnl);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		console.log(
			'getQuoteAssetTokenAmount:',
			clearingHouse.getQuoteAssetTokenAmount().toString()
		);
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(10000000)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(48000000000)));

		const market = clearingHouse.getPerpMarketAccount(0);
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

		assert(
			clearingHouse.getPerpMarketAccount(0).nextFillRecordId.eq(new BN(2))
		);
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
			await clearingHouse.withdraw(
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
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex
		);

		await clearingHouse.fetchAccounts();

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		const user = clearingHouse.getUserAccount();
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.perpPositions[0].quoteEntryAmount.toNumber()
		);

		assert.ok(user.perpPositions[0].quoteAssetAmount.eq(new BN(-24072002)));
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(-24000001)));

		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(24000000000)));
		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(10000000)));
		console.log(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(72001))
		);

		const market = clearingHouse.getPerpMarketAccount(0);
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
		const marketData = clearingHouse.getPerpMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.0, marketData.amm.oracle);

		const baseAssetAmount = new BN(48000000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			0
		);

		await clearingHouse.fetchAccounts();
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			0
		);

		await clearingHouse.fetchAccounts();
		const user = clearingHouse.getUserAccount();
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.perpPositions[0].quoteEntryAmount.toNumber()
		);
		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		console.log(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9879998)));
		assert(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(120001))
		);
		console.log(user.perpPositions[0].quoteEntryAmount.toString());

		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(24000000)));
		assert.ok(user.perpPositions[0].quoteAssetAmount.eq(new BN(24000000)));
		console.log(user.perpPositions[0].baseAssetAmount.toString());
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(-24000000000)));

		const market = clearingHouse.getPerpMarketAccount(0);
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
		const txSig = await clearingHouse.closePosition(marketIndex);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(0)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9855998)));
		console.log(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert(
			clearingHouse
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(144001))
		);

		const market = clearingHouse.getPerpMarketAccount(0);
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
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			0
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			0
		);

		const user = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		console.log(user.perpPositions[0].quoteEntryAmount.toString());
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(47999999)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(-48000000000)));

		const market = clearingHouse.getPerpMarketAccount(0);
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

		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		try {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				clearingHouse.getPerpMarketAccount(0).amm.orderStepSize,
				0
			);
		} catch (e) {
			console.log(e);
		}
	});

	it('Short order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = 0;
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const estTradePrice = calculateTradeSlippage(
			PositionDirection.SHORT,
			baseAssetAmount,
			market,
			'base',
			undefined,
			true
		)[2];

		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex,
			estTradePrice
		);

		await clearingHouse.fetchAccounts();

		await clearingHouse.closePosition(marketIndex);
	});

	it('Long order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = 0;
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const estTradePrice = calculateTradeSlippage(
			PositionDirection.LONG,
			baseAssetAmount,
			market,
			'base'
		)[2];

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex,
			estTradePrice
		);

		await clearingHouse.fetchAccounts();

		await clearingHouse.closePosition(marketIndex);
	});
});
