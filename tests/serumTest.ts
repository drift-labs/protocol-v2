import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Transaction } from '@solana/web3.js';
const serumHelper = require('./serumHelper');

import {
	Admin,
	BN,
	ClearingHouse,
	EventSubscriber,
	OracleSource,
	OracleInfo,
	PositionDirection,
	castNumberToBankPrecision,
	getLimitOrderParams,
	getTokenAmount,
	isVariant,
	MARK_PRICE_PRECISION,
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteAssetBank,
	initializeSolAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { Market } from '@project-serum/serum';
import { BankBalanceType } from '../sdk';

describe('serum spot market', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		skipPreflight: false,
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let makerClearingHouse: Admin;
	let makerWSOL: PublicKey;

	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let solOracle: PublicKey;

	let serumMarketPublicKey: PublicKey;

	let usdcMint;
	let makerUSDC;

	let takerClearingHouse: ClearingHouse;
	let takerWSOL: PublicKey;
	let takerUSDC: PublicKey;

	const usdcAmount = new BN(200 * 10 ** 6);
	const solAmount = new BN(2 * 10 ** 9);

	let marketIndexes: BN[];
	let bankIndexes: BN[];
	let oracleInfos: OracleInfo[];

	const solBankIndex = new BN(1);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		makerUSDC = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		makerWSOL = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			solAmount
		);

		solOracle = await mockOracle(30);

		marketIndexes = [];
		bankIndexes = [new BN(0), new BN(1)];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		makerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
			oracleInfos,
		});

		await makerClearingHouse.initialize(usdcMint.publicKey, true);
		await makerClearingHouse.subscribe();
		await makerClearingHouse.initializeUserAccount();

		await initializeQuoteAssetBank(makerClearingHouse, usdcMint.publicKey);
		await initializeSolAssetBank(makerClearingHouse, solOracle);
		await makerClearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		[takerClearingHouse, takerWSOL, takerUSDC] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				[new BN(0), new BN(1)],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);

		await takerClearingHouse.deposit(usdcAmount, new BN(0), takerUSDC);
	});

	it('Add Serum Market', async () => {
		serumMarketPublicKey = await serumHelper.listMarket({
			connection,
			wallet: provider.wallet,
			baseMint: NATIVE_MINT,
			quoteMint: usdcMint.publicKey,
			baseLotSize: 100000000,
			quoteLotSize: 100,
			dexProgramId: serumHelper.DEX_PID,
			feeRateBps: 0,
		});

		await makerClearingHouse.addSerumMarket(
			solBankIndex,
			serumMarketPublicKey,
			serumHelper.DEX_PID
		);
	});

	const crankMarkets = async () => {
		const openOrderAccounts = [];

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);
		const makerOpenOrders = (
			await market.findOpenOrdersAccountsForOwner(
				connection,
				provider.wallet.publicKey
			)
		)[0];
		openOrderAccounts.push(makerOpenOrders.publicKey);

		openOrderAccounts.push(
			takerClearingHouse.getBankAccount(solBankIndex).serumOpenOrders
		);

		const consumeEventsIx = await market.makeConsumeEventsInstruction(
			openOrderAccounts,
			10
		);

		const consumeEventsTx = new Transaction().add(consumeEventsIx);
		await provider.sendAndConfirm(consumeEventsTx, []);

		// Open orders need to be sorted correctly but not sure how to do it in js, so will run this
		// ix sorted in both direction
		const consumeEventsIx2 = await market.makeConsumeEventsInstruction(
			openOrderAccounts.reverse(),
			10
		);

		const consumeEventsTx2 = new Transaction().add(consumeEventsIx2);
		await provider.sendAndConfirm(consumeEventsTx2, []);
	};

	it('Fill bid', async () => {
		const baseAssetAmount = castNumberToBankPrecision(
			1,
			makerClearingHouse.getBankAccount(solBankIndex)
		);

		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solBankIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(MARK_PRICE_PRECISION),
			})
		);

		const spotOrder = takerClearingHouse.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		// @ts-ignore
		const { transaction, signers } = await market.makePlaceOrderTransaction(
			provider.connection,
			{
				// @ts-ignore
				owner: provider.wallet,
				payer: makerWSOL,
				side: 'sell',
				price: 100,
				size: 1,
				orderType: 'postOnly',
				clientId: undefined, // todo?
				openOrdersAddressKey: undefined,
				openOrdersAccount: undefined,
				feeDiscountPubkey: null,
				selfTradeBehavior: 'abortTransaction',
			}
		);

		await provider.sendAndConfirm(transaction, signers);

		const txSig = await makerClearingHouse.fillSpotOrder(
			await takerClearingHouse.getUserAccountPublicKey(),
			takerClearingHouse.getUserAccount(),
			takerClearingHouse.getOrderByUserId(1)
		);

		await printTxLogs(connection, txSig);

		await takerClearingHouse.fetchAccounts();

		const takerQuoteBankBalance = takerClearingHouse.getUserBankBalance(0);
		const takerBaseBankBalance = takerClearingHouse.getUserBankBalance(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteBankBalance.balance,
			takerClearingHouse.getQuoteAssetBankAccount(),
			takerQuoteBankBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99959999)));

		const baseTokenAmount = getTokenAmount(
			takerBaseBankBalance.balance,
			takerClearingHouse.getBankAccount(new BN(1)),
			takerBaseBankBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerClearingHouse.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(40000)));
		assert(orderActionRecord.takerOrderFee.eq(new BN(40000)));

		const quoteBank = takerClearingHouse.getQuoteAssetBankAccount();
		const spotFeePool = getTokenAmount(
			quoteBank.spotFeePool.balance,
			quoteBank,
			BankBalanceType.DEPOSIT
		);
		assert(spotFeePool.eq(new BN(0)));

		await crankMarkets();
	});

	it('Fill ask', async () => {
		const baseAssetAmount = castNumberToBankPrecision(
			1,
			makerClearingHouse.getBankAccount(solBankIndex)
		);

		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solBankIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(MARK_PRICE_PRECISION),
			})
		);

		const spotOrder = takerClearingHouse.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		// @ts-ignore
		const { transaction, signers } = await market.makePlaceOrderTransaction(
			provider.connection,
			{
				// @ts-ignore
				owner: provider.wallet,
				payer: makerUSDC.publicKey,
				side: 'buy',
				price: 100,
				size: 1,
				orderType: 'postOnly',
				clientId: undefined, // todo?
				openOrdersAddressKey: undefined,
				openOrdersAccount: undefined,
				feeDiscountPubkey: null,
				selfTradeBehavior: 'abortTransaction',
			}
		);

		await provider.sendAndConfirm(transaction, signers);

		const txSig = await makerClearingHouse.fillSpotOrder(
			await takerClearingHouse.getUserAccountPublicKey(),
			takerClearingHouse.getUserAccount(),
			takerClearingHouse.getOrderByUserId(1)
		);

		await printTxLogs(connection, txSig);

		await takerClearingHouse.fetchAccounts();

		const takerQuoteBankBalance = takerClearingHouse.getUserBankBalance(0);
		const takerBaseBankBalance = takerClearingHouse.getUserBankBalance(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteBankBalance.balance,
			takerClearingHouse.getQuoteAssetBankAccount(),
			takerQuoteBankBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(199919999)));

		const baseTokenAmount = getTokenAmount(
			takerBaseBankBalance.balance,
			takerClearingHouse.getBankAccount(new BN(1)),
			takerBaseBankBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(0)));

		const takerOrder = takerClearingHouse.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerOrderFee.eq(new BN(40000)));
		assert(orderActionRecord.takerFee.eq(new BN(40000)));

		await takerClearingHouse.fetchAccounts();
		const quoteBank = takerClearingHouse.getQuoteAssetBankAccount();
		const spotFeePoolDeposit = getTokenAmount(
			quoteBank.spotFeePool.balance,
			quoteBank,
			BankBalanceType.DEPOSIT
		);
		assert(spotFeePoolDeposit.eq(new BN(8000)));

		await crankMarkets();
	});

	// check that moving referrer rebates works properly
	it('Fill bid second time', async () => {
		const baseAssetAmount = castNumberToBankPrecision(
			1,
			makerClearingHouse.getBankAccount(solBankIndex)
		);

		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solBankIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(MARK_PRICE_PRECISION),
			})
		);

		const spotOrder = takerClearingHouse.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		// @ts-ignore
		const { transaction, signers } = await market.makePlaceOrderTransaction(
			provider.connection,
			{
				// @ts-ignore
				owner: provider.wallet,
				payer: makerWSOL,
				side: 'sell',
				price: 100,
				size: 1,
				orderType: 'postOnly',
				clientId: undefined, // todo?
				openOrdersAddressKey: undefined,
				openOrdersAccount: undefined,
				feeDiscountPubkey: null,
				selfTradeBehavior: 'abortTransaction',
			}
		);

		await provider.sendAndConfirm(transaction, signers);

		const txSig = await makerClearingHouse.fillSpotOrder(
			await takerClearingHouse.getUserAccountPublicKey(),
			takerClearingHouse.getUserAccount(),
			takerClearingHouse.getOrderByUserId(1)
		);

		await printTxLogs(connection, txSig);

		await takerClearingHouse.fetchAccounts();

		const takerQuoteBankBalance = takerClearingHouse.getUserBankBalance(0);
		const takerBaseBankBalance = takerClearingHouse.getUserBankBalance(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteBankBalance.balance,
			takerClearingHouse.getQuoteAssetBankAccount(),
			takerQuoteBankBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99879998))); // paid ~$.12

		const baseTokenAmount = getTokenAmount(
			takerBaseBankBalance.balance,
			takerClearingHouse.getBankAccount(new BN(1)),
			takerBaseBankBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerClearingHouse.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(40000)));
		assert(orderActionRecord.takerOrderFee.eq(new BN(40000)));

		const quoteBank = takerClearingHouse.getQuoteAssetBankAccount();
		const spotFeePool = getTokenAmount(
			quoteBank.spotFeePool.balance,
			quoteBank,
			BankBalanceType.DEPOSIT
		);
		assert(spotFeePool.eq(new BN(16000)));

		await crankMarkets();
	});
});
