import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	isVariant,
	MarketAccount,
	OracleSource,
	ZERO,
} from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey, TransactionSignature } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateTradeSlippage,
	PositionDirection,
	getMarketPublicKey,
	EventSubscriber,
	QUOTE_ASSET_BANK_INDEX,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	setFeedPrice,
	initializeQuoteAssetBank,
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

		solUsd = await mockOracle(1);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
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
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [expectedInsuranceAccountAuthority, expectedInsuranceAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.insuranceVault.toBuffer()],
				clearingHouse.program.programId
			);
		assert.ok(
			state.insuranceVaultAuthority.equals(expectedInsuranceAccountAuthority)
		);
		assert.ok(state.insuranceVaultNonce == expectedInsuranceAccountNonce);

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR

		const marketIndex = new BN(0);
		const txSig = await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const marketPublicKey = await getMarketPublicKey(
			clearingHouse.program.programId,
			marketIndex
		);
		const market = (await clearingHouse.program.account.market.fetch(
			marketPublicKey
		)) as MarketAccount;

		assert.ok(market.initialized);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.openInterest.eq(new BN(0)));

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
				clearingHouse.getUserBankBalance(QUOTE_ASSET_BANK_INDEX).balanceType,
				'deposit'
			)
		);

		// Check that clearing house collateral account has proper collateral
		const quoteAssetBankVault = await getTokenAccount(
			provider,
			clearingHouse.getQuoteAssetBankAccount().vault
		);
		assert.ok(quoteAssetBankVault.amount.eq(usdcAmount));

		assert.ok(user.positions.length == 5);
		assert.ok(user.positions[0].baseAssetAmount.toNumber() === 0);
		assert.ok(user.positions[0].quoteEntryAmount.toNumber() === 0);
		assert.ok(user.positions[0].lastCumulativeFundingRate.toNumber() === 0);

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
			QUOTE_ASSET_BANK_INDEX,
			userUSDCAccount.publicKey,
			true
		);

		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(ZERO));

		// Check that clearing house collateral account has proper collateral]
		const quoteAssetBankVaultAmount = await getTokenAmountAsBN(
			connection,
			clearingHouse.getQuoteAssetBankAccount().vault
		);
		assert.ok(quoteAssetBankVaultAmount.eq(ZERO));

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
			QUOTE_ASSET_BANK_INDEX,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(480000000000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);
		await printTxLogs(connection, txSig);
		const marketData = clearingHouse.getMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.01, marketData.amm.oracle);

		await eventSubscriber.awaitTx(txSig);
		const orderR = eventSubscriber.getEventsArray('OrderRecord')[0];
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
		console.log('unsettledPnl:', user.positions[0].unsettledPnl.toString());
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9951996)));
		assert(user.fees.totalFeePaid.eq(new BN(48004)));

		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(48004609)));
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(480000000000000)));
		assert.ok(user.positions[0].unsettledPnl.eq(new BN(0)));

		const market = clearingHouse.getMarketAccount(0);
		console.log(market.amm.netBaseAssetAmount.toNumber());
		console.log(market);

		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(480000000000000)));
		console.log(market.amm.totalFee.toString());
		assert.ok(market.amm.totalFee.eq(new BN(48004)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(48004)));

		await eventSubscriber.awaitTx(txSig);
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

		assert(clearingHouse.getMarketAccount(0).nextFillRecordId.eq(new BN(2)));
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
				QUOTE_ASSET_BANK_INDEX,
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
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(240000000000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		const user0 = clearingHouse.getUserAccount();
		console.log(
			'before unsettledPnl:',
			user0.positions[0].unsettledPnl.toString()
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		const user = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user.positions[0].unsettledPnl.toString()
		);
		console.log(
			'quoteAssetAmount:',
			user.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.positions[0].quoteEntryAmount.toNumber()
		);

		assert.ok(user.positions[0].quoteAssetAmount.eq(new BN(24002305)));
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(24002305)));

		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(240000000000000)));
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9929145)));
		assert(user.fees.totalFeePaid.eq(new BN(72007)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(240000000000000)));
		assert.ok(market.amm.totalFee.eq(new BN(72007)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(72007)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(240000000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24003456)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Reverse long position', async () => {
		const marketData = clearingHouse.getMarketAccount(0);
		await setFeedPrice(anchor.workspace.Pyth, 1.0, marketData.amm.oracle);

		const baseAssetAmount = new BN(480000000000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const user0 = clearingHouse.getUserAccount();
		console.log(
			'before unsettledPnl:',
			user0.positions[0].unsettledPnl.toString()
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const user = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user.positions[0].unsettledPnl.toString()
		);
		console.log(
			'quoteAssetAmount:',
			user.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.positions[0].quoteEntryAmount.toNumber()
		);
		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9878840)));
		assert(user.fees.totalFeePaid.eq(new BN(120007)));
		console.log(user.positions[0].quoteEntryAmount.toString());

		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(24000000)));
		assert.ok(user.positions[0].quoteAssetAmount.eq(new BN(24000000)));
		console.log(user.positions[0].baseAssetAmount.toString());
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(-240000000000000)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-240000000000000)));
		assert.ok(market.amm.totalFee.eq(new BN(120007)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(120007)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(480000000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(48000000)));

		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Close position', async () => {
		const marketIndex = new BN(0);
		const txSig = await clearingHouse.closePosition(marketIndex);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(0)));
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9855993)));
		assert(user.fees.totalFeePaid.eq(new BN(144005)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(144005)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(144005)));

		await eventSubscriber.awaitTx(txSig);
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

	it('Open short position', async () => {
		const baseAssetAmount = new BN(480000000000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			baseAssetAmount,
			new BN(0)
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		const user = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		console.log(user.positions[0].quoteEntryAmount.toString());
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(47995392)));
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(-480000000000000)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-480000000000000)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(5)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(480000000000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(47995392)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
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
			QUOTE_ASSET_BANK_INDEX,
			userUSDCAccount.publicKey
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			clearingHouse.getMarketAccount(new BN(0)).amm.baseAssetAmountStepSize,
			new BN(0)
		);
	});

	it('Short order succeeds due to realiziable limit price ', async () => {
		const baseAssetAmount = BASE_PRECISION;
		const marketIndex = new BN(0);
		const market = clearingHouse.getMarketAccount(marketIndex);
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
		const marketIndex = new BN(0);
		const market = clearingHouse.getMarketAccount(marketIndex);
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
