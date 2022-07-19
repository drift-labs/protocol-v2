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
	calculateMarkPrice,
	calculateTradeSlippage,
	ClearingHouseUser,
	PositionDirection,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	convertToNumber,
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
	let userAccount: ClearingHouseUser;

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
		await userAccount.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize State', async () => {
		await clearingHouse.initialize(usdcMint.publicKey, true);

		await clearingHouse.subscribe();
		const state = clearingHouse.getStateAccount();
		await clearingHouse.updateOrderAuctionTime(new BN(0));

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
		const baseAssetAmount = new BN(497450500000000);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);
		await printTxLogs(connection, txSig);

		await eventSubscriber.awaitTx(txSig);
		console.log(
			eventSubscriber.getEventsArray('OrderRecord')[0].takerFee.toString()
		);

		const txSigSettlePnl = await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSigSettlePnl);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9950249)));
		assert(user.fees.totalFeePaid.eq(new BN(49750)));

		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(49750000)));
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(497450500000000)));

		const market = clearingHouse.getMarketAccount(0);
		console.log(market.amm.netBaseAssetAmount.toNumber());
		console.log(market);

		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(497450500000000)));
		console.log(market.amm.totalFee.toString());
		assert.ok(market.amm.totalFee.eq(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(49750)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(497450500000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(49750000)));
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

	it('Order fails due to unrealiziable limit price ', async () => {
		// Should be a better a way to catch an exception with chai but wasn't working for me
		try {
			const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
			const marketIndex = new BN(0);
			const market = clearingHouse.getMarketAccount(marketIndex);
			const estTradePrice = calculateTradeSlippage(
				PositionDirection.SHORT,
				newUSDCNotionalAmount,
				market
			)[2];

			// trying to sell at price too high
			const limitPriceTooHigh = calculateMarkPrice(market);
			console.log(
				'failed order:',
				estTradePrice.toNumber(),
				limitPriceTooHigh.toNumber()
			);

			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				newUSDCNotionalAmount,
				marketIndex,
				limitPriceTooHigh
			);
			assert(false, 'Order succeeded');
		} catch (e) {
			assert(e.message.includes('0x177f'));
		}
	});

	it('Reduce long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(248725250000000);
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

		assert.ok(user.positions[0].quoteAssetAmount.eq(new BN(24873762)));
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(24875000)));
		console.log(user.positions[0].baseAssetAmount.toNumber());
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(248725250000000)));

		console.log(clearingHouse.getQuoteAssetTokenAmount().toString());
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9925373)));
		assert(user.fees.totalFeePaid.eq(new BN(74626)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(248725250000000)));
		assert.ok(market.amm.totalFee.eq(new BN(74626)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(74626)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(2)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(248725250000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24876237)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Reverse long position', async () => {
		const baseAssetAmount = new BN(497450500000000);
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
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9874391)));
		assert(user.fees.totalFeePaid.eq(new BN(124371)));
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(24872525)));
		assert.ok(user.positions[0].quoteAssetAmount.eq(new BN(24872525)));
		console.log(user.positions[0].baseAssetAmount.toString());
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(-248725250000000)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-248725250000000)));
		assert.ok(market.amm.totalFee.eq(new BN(124371)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(124371)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(497450500000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(49745050)));

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
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(9850757)));
		assert(user.fees.totalFeePaid.eq(new BN(149242)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.amm.totalFee.eq(new BN(149242)));
		assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(149242)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(4)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(248725250000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(24871288)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Open short position', async () => {
		const baseAssetAmount = new BN(490122700000000);
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
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(49007466)));
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(-490122700000000)));

		const market = clearingHouse.getMarketAccount(0);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-490122700000000)));

		await eventSubscriber.awaitTx(txSig);
		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.fillRecordId.eq(new BN(5)));
		assert.ok(
			JSON.stringify(orderRecord.takerOrder.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(490122700000000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.eq(new BN(49007466)));
		assert.ok(orderRecord.marketIndex.eq(new BN(0)));
	});

	it('Partial Liquidation', async () => {
		const marketIndex = new BN(0);

		userAccount = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();

		const user0: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		const liqPrice = userAccount.liquidationPrice(
			user0.positions[0],
			new BN(0),
			true
		);
		console.log(convertToNumber(liqPrice));

		console.log(
			'liqPrice move:',
			convertToNumber(
				calculateMarkPrice(clearingHouse.getMarketAccount(marketIndex))
			),
			'->',
			convertToNumber(liqPrice),
			'on position',
			convertToNumber(
				user0.positions[0].baseAssetAmount,
				AMM_RESERVE_PRECISION
			),
			'with collateral:',
			convertToNumber(clearingHouse.getQuoteAssetTokenAmount(), QUOTE_PRECISION)
		);

		const marketData = clearingHouse.getMarketAccount(0);
		await setFeedPrice(
			anchor.workspace.Pyth,
			convertToNumber(liqPrice),
			marketData.amm.oracle
		);

		await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);
		console.log('margin ratio', userAccount.getMarginRatio().toString());

		console.log(
			'collateral + pnl post px move:',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		const txSig = await clearingHouse.liquidate(userAccountPublicKey);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		console.log(
			'collateral + pnl post liq:',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);
		console.log('can be liquidated', userAccount.canBeLiquidated());
		console.log('margin ratio', userAccount.getMarginRatio().toString());

		const state: any = clearingHouse.getStateAccount();
		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(
			user.positions[0].baseAssetAmount
				.abs()
				.lt(user0.positions[0].baseAssetAmount.abs())
		);
		assert.ok(
			user.positions[0].quoteEntryAmount
				.abs()
				.lt(user0.positions[0].quoteEntryAmount.abs())
		);

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceVault
		);
		console.log(chInsuranceAccountToken.amount.toNumber());

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(43227)));

		await eventSubscriber.awaitTx(txSig);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert.ok(liquidationRecord.user.equals(userAccountPublicKey));
		assert.ok(liquidationRecord.partial);

		assert.ok(liquidationRecord.baseAssetValue.eq(new BN(55350813)));
		assert.ok(liquidationRecord.baseAssetValueClosed.eq(new BN(13837703)));
		assert.ok(liquidationRecord.liquidationFee.eq(new BN(86453)));
		assert.ok(liquidationRecord.feeToLiquidator.eq(new BN(43226)));
		assert.ok(liquidationRecord.feeToInsuranceFund.eq(new BN(43227)));
		assert.ok(liquidationRecord.liquidator.equals(userAccountPublicKey));
		assert.ok(liquidationRecord.totalCollateral.eq(new BN(3458403)));
		assert.ok(liquidationRecord.collateral.eq(new BN(9801749)));
		assert.ok(liquidationRecord.unrealizedPnl.eq(new BN(-6343346)));
		assert.ok(liquidationRecord.marginRatio.eq(new BN(624)));
	});

	it('Full Liquidation', async () => {
		const marketIndex = new BN(0);

		const user0: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		const liqPrice = userAccount.liquidationPrice(
			user0.positions[0],
			new BN(0),
			false
		);
		console.log(convertToNumber(liqPrice));
		const marketData = clearingHouse.getMarketAccount(0);
		await setFeedPrice(
			anchor.workspace.Pyth,
			convertToNumber(liqPrice),
			marketData.amm.oracle
		);

		await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);

		// having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
		const txSig = await clearingHouse.liquidate(userAccountPublicKey);

		await clearingHouse.fetchAccounts();
		const user01 = clearingHouse.getUserAccount();
		console.log(
			'before unsettledPnl:',
			user01.positions[0].unsettledPnl.toString()
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const user1 = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user1.positions[0].unsettledPnl.toString()
		);
		console.log(
			'quoteAssetAmount:',
			user1.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user1.positions[0].quoteEntryAmount.toNumber()
		);

		const state: any = clearingHouse.getStateAccount();
		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		console.log(
			convertToNumber(user.positions[0].baseAssetAmount, AMM_RESERVE_PRECISION)
		);
		assert.ok(user.positions[0].baseAssetAmount.eq(new BN(0)));
		assert.ok(user.positions[0].quoteEntryAmount.eq(new BN(0)));
		assert.ok(clearingHouse.getQuoteAssetTokenAmount().eq(new BN(106967)));
		assert.ok(user.positions[0].lastCumulativeFundingRate.eq(new BN(0)));

		const chInsuranceAccountToken = await getTokenAccount(
			provider,
			state.insuranceVault
		);
		console.log(chInsuranceAccountToken.amount.toNumber());

		assert.ok(chInsuranceAccountToken.amount.eq(new BN(2075604)));

		await eventSubscriber.awaitTx(txSig);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert.ok(liquidationRecord.user.equals(userAccountPublicKey));
		assert.ok(!liquidationRecord.partial);
		assert.ok(liquidationRecord.baseAssetValue.eq(new BN(42790023)));
		assert.ok(liquidationRecord.baseAssetValueClosed.eq(new BN(42790023)));
		assert.ok(liquidationRecord.liquidationFee.eq(new BN(2139344)));
		assert.ok(liquidationRecord.feeToLiquidator.eq(new BN(106967)));
		assert.ok(liquidationRecord.feeToInsuranceFund.eq(new BN(2032377)));
		assert.ok(liquidationRecord.liquidator.equals(userAccountPublicKey));
		assert.ok(liquidationRecord.totalCollateral.eq(new BN(2139344)));
		assert.ok(liquidationRecord.collateral.eq(new BN(3415176)));
		assert.ok(liquidationRecord.unrealizedPnl.eq(new BN(-1275832)));
		assert.ok(liquidationRecord.marginRatio.eq(new BN(499)));
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
