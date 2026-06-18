import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	isVariant,
	PerpMarketAccount,
	OracleSource,
	ZERO,
} from '../../packages/sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey, TransactionSignature } from '@solana/web3.js';

import {
	TestClient,
	calculateTradeSlippage,
	PositionDirection,
	getPerpMarketPublicKey,
	EventSubscriber,
	QUOTE_SPOT_MARKET_INDEX,
} from '../../packages/sdk/src';

import {
	getProtocolFeeTotal,
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
	mintUSDCToUser,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('velocity client', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
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

		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		velocityClient = new TestClient({
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
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize State', async () => {
		await velocityClient.initialize(usdcMint.publicKey, true);

		await velocityClient.subscribe();
		const state = velocityClient.getStateAccount();
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		assert.ok(
			state.coldAdmin.equals(bankrunContextWrapper.provider.wallet.publicKey)
		);

		const expectedSigner = velocityClient.getSignerPublicKey();
		assert(state.signer.equals(expectedSigner));

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR

		const marketIndex = 0;
		const txSig = await velocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		await velocityClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);

		bankrunContextWrapper.connection.printTxLogs(txSig);

		const marketPublicKey = await getPerpMarketPublicKey(
			velocityClient.program.programId,
			marketIndex
		);
		const market = (await velocityClient.program.account.perpMarket.fetch(
			marketPublicKey
		)) as PerpMarketAccount;

		assert.ok(JSON.stringify(market.status) === JSON.stringify({ active: {} }));
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
		assert.ok(market.numberOfUsersWithBase === 0);

		const ammD = market.amm;
		console.log(market.oracle.toString());
		assert.ok(market.oracle.equals(solUsd));
		assert.ok(ammD.baseAssetReserve.eq(ammInitialBaseAssetAmount));
		assert.ok(ammD.quoteAssetReserve.eq(ammInitialQuoteAssetAmount));
		assert.ok(market.cumulativeFundingRateLong.eq(new BN(0)));
		assert.ok(market.cumulativeFundingRateShort.eq(new BN(0)));
		assert.ok(market.marketStats.fundingPeriod.eq(periodicity));
		assert.ok(market.lastFundingRate.eq(new BN(0)));
		assert.ok(!market.lastFundingRateTs.eq(new BN(0)));
		assert.ok(
			!market.marketStats.historicalOracleData.lastOraclePriceTwapTs.eq(
				new BN(0)
			)
		);
	});

	it('Initialize user account and deposit collateral atomically', async () => {
		let txSig: TransactionSignature;
		[txSig, userAccountPublicKey] =
			await velocityClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await velocityClient.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(
			user.authority.equals(bankrunContextWrapper.provider.wallet.publicKey)
		);
		const depositTokenAmount = velocityClient.getQuoteAssetTokenAmount();
		assert(depositTokenAmount.eq(usdcAmount));
		assert(
			isVariant(
				velocityClient.getSpotPosition(QUOTE_SPOT_MARKET_INDEX).balanceType,
				'deposit'
			)
		);

		// Check that velocity collateral account has proper collateral
		const quoteSpotVault =
			await bankrunContextWrapper.connection.getTokenAccount(
				velocityClient.getQuoteSpotMarketAccount().vault
			);

		assert.ok(new BN(Number(quoteSpotVault.amount)).eq(usdcAmount));

		assert.ok(user.perpPositions.length == 8);
		assert.ok(user.perpPositions[0].baseAssetAmount.toNumber() === 0);
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.toNumber() === 0);
		assert.ok(user.perpPositions[0].lastCumulativeFundingRate.toNumber() === 0);

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

	it('Withdraw Collateral', async () => {
		await velocityClient.withdraw(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey,
			true
		);

		await velocityClient.fetchAccounts();
		assert(velocityClient.getQuoteAssetTokenAmount().eq(ZERO));

		// Check that velocity collateral account has proper collateral]
		const quoteSpotVault =
			await bankrunContextWrapper.connection.getTokenAccount(
				velocityClient.getQuoteSpotMarketAccount().vault
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
		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const baseAssetAmount = new BN(48000000000);
		const txSig = await velocityClient.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const marketData = velocityClient.getPerpMarketAccount(0);
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			1.01,
			marketData.oracle,
			10000
		);

		const orderR = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		console.log(orderR.takerFee.toString());
		console.log(orderR.baseAssetAmountFilled.toString());

		const user: any = await velocityClient.program.account.user.fetch(
			userAccountPublicKey
		);

		console.log(
			'getQuoteAssetTokenAmount:',
			velocityClient.getQuoteAssetTokenAmount().toString()
		);
		assert(velocityClient.getQuoteAssetTokenAmount().eq(new BN(10000000)));
		assert(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(48001))
		);

		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(-48000001)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(-48048002)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(48000000000)));

		const market = velocityClient.getPerpMarketAccount(0);
		console.log(market.amm.baseAssetAmountWithAmm.toNumber());
		console.log(market);

		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(48000000000)));
		console.log(market.amm.totalFee.toString());
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(48001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(48001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderActionRecord.fillRecordId.eq(new BN(1)));
		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(new BN(48000000000)));
		assert.ok(orderActionRecord.quoteAssetAmountFilled.eq(new BN(48000001)));
		assert.ok(orderActionRecord.marketIndex === marketIndex);

		assert.ok(orderActionRecord.takerExistingQuoteEntryAmount === null);
		assert.ok(orderActionRecord.takerExistingBaseAssetAmount === null);

		assert(
			velocityClient.getPerpMarketAccount(0).nextFillRecordId.eq(new BN(2))
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
			await velocityClient.withdraw(
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
		await velocityClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex
		);

		await velocityClient.fetchAccounts();

		await velocityClient.fetchAccounts();
		const user = velocityClient.getUserAccount();
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
		console.log(velocityClient.getQuoteAssetTokenAmount().toString());
		assert.ok(velocityClient.getQuoteAssetTokenAmount().eq(new BN(10000000)));
		console.log(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(72001))
		);

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(24000000000)));
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(72001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(72001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

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
		const marketData = velocityClient.getPerpMarketAccount(0);
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			1.0,
			marketData.oracle,
			10000
		);

		const baseAssetAmount = new BN(48000000000);
		await velocityClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			0
		);

		await velocityClient.fetchAccounts();
		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0
		);

		await velocityClient.fetchAccounts();
		const user = velocityClient.getUserAccount();
		console.log(
			'quoteAssetAmount:',
			user.perpPositions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteBreakEvenAmount:',
			user.perpPositions[0].quoteBreakEvenAmount.toNumber()
		);
		console.log(velocityClient.getQuoteAssetTokenAmount().toString());
		console.log(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert.ok(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9879998)));
		assert(
			velocityClient
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

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-24000000000)));
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus.
		// settlePNL above ran the streaming sweep, and the protocol drain is
		// buffer-exempt — part of the pending fee may already have
		// materialized into protocol_fee_pool, so assert conservation
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(120001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(120001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

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
		await velocityClient.closePosition(marketIndex);

		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			marketIndex
		);

		const user: any = await velocityClient.program.account.user.fetch(
			userAccountPublicKey
		);
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(0)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		console.log(velocityClient.getQuoteAssetTokenAmount().toString());
		assert.ok(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9855998)));
		console.log(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.toString()
		);
		assert(
			velocityClient
				.getUserStats()
				.getAccountAndSlot()
				.data.fees.totalFeePaid.eq(new BN(144001))
		);

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(0)));
		// post AMM-isolation: the gross fee is on the ledger (protocol residual
		// under the default split); the AMM books only its spread surplus.
		// the buffer-exempt protocol drain may have materialized part of the
		// pending fee into protocol_fee_pool — assert conservation
		assert.ok(market.feeLedger.totalExchangeFee.eq(new BN(144001)));
		assert.ok(getProtocolFeeTotal(velocityClient, market).eq(new BN(144001)));
		assert.ok(market.amm.totalFee.eq(market.amm.totalFeeMinusDistributions));

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
		const baseAssetAmount = new BN(48000000000);
		await velocityClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			0
		);

		await velocityClient.settlePNL(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0
		);

		const user = await velocityClient.program.account.user.fetch(
			userAccountPublicKey
		);
		console.log(user.perpPositions[0].quoteBreakEvenAmount.toString());
		assert.ok(user.perpPositions[0].quoteEntryAmount.eq(new BN(47999999)));
		assert.ok(user.perpPositions[0].quoteBreakEvenAmount.eq(new BN(47951999)));
		assert.ok(user.perpPositions[0].baseAssetAmount.eq(new BN(-48000000000)));

		const market = velocityClient.getPerpMarketAccount(0);
		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(-48000000000)));

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
			bankrunContextWrapper
		);

		await bulkAccountLoader.load();

		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		try {
			await velocityClient.openPosition(
				PositionDirection.LONG,
				velocityClient.getPerpMarketAccount(0).orderStepSize,
				0
			);
		} catch (e) {
			console.log(e);
		}
	});

	it('Short order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = 0;
		const market = velocityClient.getPerpMarketAccount(marketIndex);
		const estTradePrice = calculateTradeSlippage(
			PositionDirection.SHORT,
			baseAssetAmount,
			market,
			'base',
			undefined,
			true
		)[2];

		await velocityClient.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex,
			estTradePrice
		);

		await velocityClient.fetchAccounts();

		await velocityClient.closePosition(marketIndex);
	});

	it('Long order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = 0;
		const market = velocityClient.getPerpMarketAccount(marketIndex);
		const estTradePrice = calculateTradeSlippage(
			PositionDirection.LONG,
			baseAssetAmount,
			market,
			'base'
		)[2];

		await velocityClient.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex,
			estTradePrice.add(market.orderTickSize)
		);

		await velocityClient.fetchAccounts();

		await velocityClient.closePosition(marketIndex);
	});
});
