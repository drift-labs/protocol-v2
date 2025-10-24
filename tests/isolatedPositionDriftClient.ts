import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BN, OracleSource, ZERO } from '../sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import { TestClient, PositionDirection, EventSubscriber } from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('drift client', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

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
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);

		await driftClient.subscribe();
		await driftClient.updatePerpAuctionDuration(new BN(0));

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
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
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize user account and deposit collateral', async () => {
		await driftClient.initializeUserAccount();

		userAccountPublicKey = await driftClient.getUserAccountPublicKey();

		const txSig = await driftClient.depositIntoIsolatedPerpPosition(
			usdcAmount,
			0,
			userUSDCAccount.publicKey
		);

		const depositTokenAmount =
			driftClient.getIsolatedPerpPositionTokenAmount(0);
		console.log('depositTokenAmount', depositTokenAmount.toString());
		assert(depositTokenAmount.eq(usdcAmount));

		// Check that drift collateral account has proper collateral
		const quoteSpotVault =
			await bankrunContextWrapper.connection.getTokenAccount(
				driftClient.getQuoteSpotMarketAccount().vault
			);

		assert.ok(new BN(Number(quoteSpotVault.amount)).eq(usdcAmount));

		await eventSubscriber.awaitTx(txSig);
		const depositRecord = eventSubscriber.getEventsArray('DepositRecord')[0];

		assert.ok(
			depositRecord.userAuthority.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ deposit: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
	});

	it('Transfer isolated perp position deposit', async () => {
		await driftClient.transferIsolatedPerpPositionDeposit(usdcAmount.neg(), 0);

		const quoteAssetTokenAmount =
			driftClient.getIsolatedPerpPositionTokenAmount(0);
		assert(quoteAssetTokenAmount.eq(ZERO));

		const quoteTokenAmount = driftClient.getQuoteAssetTokenAmount();
		assert(quoteTokenAmount.eq(usdcAmount));

		await driftClient.transferIsolatedPerpPositionDeposit(usdcAmount, 0);

		const quoteAssetTokenAmount2 =
			driftClient.getIsolatedPerpPositionTokenAmount(0);
		assert(quoteAssetTokenAmount2.eq(usdcAmount));

		const quoteTokenAmoun2 = driftClient.getQuoteAssetTokenAmount();
		assert(quoteTokenAmoun2.eq(ZERO));
	});

	it('Withdraw Collateral', async () => {
		await driftClient.withdrawFromIsolatedPerpPosition(
			usdcAmount,
			0,
			userUSDCAccount.publicKey
		);

		await driftClient.fetchAccounts();
		assert(driftClient.getIsolatedPerpPositionTokenAmount(0).eq(ZERO));

		// Check that drift collateral account has proper collateral]
		const quoteSpotVault =
			await bankrunContextWrapper.connection.getTokenAccount(
				driftClient.getQuoteSpotMarketAccount().vault
			);

		assert.ok(new BN(Number(quoteSpotVault.amount)).eq(ZERO));

		const userUSDCtoken =
			await bankrunContextWrapper.connection.getTokenAccount(
				userUSDCAccount.publicKey
			);
		assert.ok(new BN(Number(userUSDCtoken.amount)).eq(usdcAmount));

		const depositRecord = eventSubscriber.getEventsArray('DepositRecord')[0];

		assert.ok(
			depositRecord.userAuthority.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ withdraw: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
	});

	it('Long from 0 position', async () => {
		// Re-Deposit USDC, assuming we have 0 balance here
		await driftClient.depositIntoIsolatedPerpPosition(
			usdcAmount,
			0,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const baseAssetAmount = new BN(48000000000);
		const txSig = await driftClient.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const marketData = driftClient.getPerpMarketAccount(0);
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			1.01,
			marketData.amm.oracle
		);

		const orderR = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		console.log(orderR.takerFee.toString());
		console.log(orderR.baseAssetAmountFilled.toString());

		const user: any = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);

		console.log(
			'getQuoteAssetTokenAmount:',
			driftClient.getIsolatedPerpPositionTokenAmount(0).toString()
		);
		assert(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(new BN(10000000))
		);
		assert(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-48048002)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(48000000000)));
		assert.ok(user.perpPositions[0].positionFlag === 1);

		const market = driftClient.getPerpMarketAccount(0);
		console.log(market.amm.baseAssetAmountWithAmm.toNumber());
		console.log(market);

		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(48000000000)));
		console.log(market.amm.totalFee.toString());
		assert.ok(market.amm.totalFee.eq(new BN(48001)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(48001)));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(1)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(48000001)));
		assert.ok(orderActionRecord.marketIndex === marketIndex);

		assert.ok(orderActionRecord.takerExistingQuoteEntryAmount === null);
		assert.ok(orderActionRecord.takerExistingBaseAssetAmount === null);

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
			await driftClient.withdrawFromIsolatedPerpPosition(
				usdcAmount,
				0,
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
		await driftClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex
		);

		await driftClient.fetchAccounts();

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
		console.log(driftClient.getIsolatedPerpPositionTokenAmount(0).toString());
		assert.ok(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(new BN(10000000))
		);
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

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(2)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderActionRecord.marketIndex === 0);
		assert.ok(
			orderActionRecord.takerExistingQuoteEntryAmount.eq(new BN(24000000))
		);
		assert.ok(orderActionRecord.takerExistingBaseAssetAmount === null);
	});

	it('Reverse long position', async () => {
		const marketData = driftClient.getPerpMarketAccount(0);
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			1.0,
			marketData.amm.oracle
		);

		const baseAssetAmount = new BN(48000000000);
		await driftClient.openPosition(PositionDirection.SHORT, baseAssetAmount, 0);

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
		console.log(driftClient.getIsolatedPerpPositionTokenAmount(0).toString());
		console.log(
			driftClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert.ok(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(new BN(9879998))
		);
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

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(3)));
		console.log(orderActionRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(48000000)));

		assert.ok(
			orderActionRecord.takerExistingQuoteEntryAmount.eq(new BN(24000001))
		);
		assert.ok(
			orderActionRecord.takerExistingBaseAssetAmount.eq(new BN(24000000000))
		);

		assert.ok(orderActionRecord.marketIndex === 0);
	});

	it('Close position', async () => {
		const marketIndex = 0;
		await driftClient.closePosition(marketIndex);

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
		console.log(driftClient.getIsolatedPerpPositionTokenAmount(0).toString());
		assert.ok(
			driftClient.getIsolatedPerpPositionTokenAmount(0).eq(new BN(0))
		);
		assert.ok(
			driftClient.getQuoteAssetTokenAmount().eq(new BN(9855998))
		);
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

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(4)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(24000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(24000000)));
		assert.ok(orderActionRecord.marketIndex === 0);

		assert.ok(
			orderActionRecord.takerExistingQuoteEntryAmount.eq(new BN(24000000))
		);
		assert.ok(orderActionRecord.takerExistingBaseAssetAmount === null);
	});

	it('Open short position', async () => {
		// Re-Deposit USDC, assuming we have 0 balance here
		await driftClient.transferIsolatedPerpPositionDeposit(
			new BN(9855998),
			0
		);
		
		const baseAssetAmount = new BN(48000000000);
		await driftClient.openPosition(PositionDirection.SHORT, baseAssetAmount, 0);

		await driftClient.settlePNL(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);

		const user = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);
		assert.ok(user.perpPositions[0].positionFlag === 1);
		console.log(user.perpPositions[0].quoteBreakEvenAmount.toString());
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(47999999)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(47951999)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(-48000000000)));

		const market = driftClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-48000000000)));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(5)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(47999999)));
		assert.ok(orderActionRecord.marketIndex === 0);
	});
});
