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
	castNumberToSpotPrecision,
	getLimitOrderParams,
	getTokenAmount,
	isVariant,
	PRICE_PRECISION,
	SpotBalanceType,
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { Market } from '@project-serum/serum';

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
	let _takerWSOL: PublicKey;
	let takerUSDC: PublicKey;

	const usdcAmount = new BN(200 * 10 ** 6);
	const solAmount = new BN(2 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	const solSpotMarketIndex = 1;

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
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		makerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});

		await makerClearingHouse.initialize(usdcMint.publicKey, true);
		await makerClearingHouse.subscribe();
		await makerClearingHouse.initializeUserAccount();

		await initializeQuoteSpotMarket(makerClearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(makerClearingHouse, solOracle);
		await makerClearingHouse.updateSpotAuctionDuration(0);

		[takerClearingHouse, _takerWSOL, takerUSDC] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);

		await takerClearingHouse.deposit(usdcAmount, 0, takerUSDC);
	});

	after(async () => {
		await takerClearingHouse.unsubscribe();
		await makerClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
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

		await makerClearingHouse.initializeSerumFulfillmentConfig(
			solSpotMarketIndex,
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

		const serumFulfillmentConfigAccount =
			await makerClearingHouse.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);
		openOrderAccounts.push(serumFulfillmentConfigAccount.serumOpenOrders);

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
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerClearingHouse.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);

		await takerClearingHouse.fetchAccounts();

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

		const serumFulfillmentConfigAccount =
			await makerClearingHouse.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);
		const txSig = await makerClearingHouse.fillSpotOrder(
			await takerClearingHouse.getUserAccountPublicKey(),
			takerClearingHouse.getUserAccount(),
			takerClearingHouse.getOrderByUserId(1),
			serumFulfillmentConfigAccount
		);

		await printTxLogs(connection, txSig);

		await takerClearingHouse.fetchAccounts();

		const takerQuoteSpotBalance = takerClearingHouse.getSpotPosition(0);
		const takerBaseSpotBalance = takerClearingHouse.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99900000)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.balance,
			takerClearingHouse.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerClearingHouse.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));
		assert(orderActionRecord.takerOrderFee.eq(new BN(100000)));

		assert(makerClearingHouse.getQuoteAssetTokenAmount().eq(new BN(10000)));

		const solSpotMarket =
			takerClearingHouse.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(58000)));
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		assert(spotFeePoolAmount.eq(new BN(50000)));

		await crankMarkets();
	});

	it('Fill ask', async () => {
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerClearingHouse.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);
		await takerClearingHouse.fetchAccounts();

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

		const serumFulfillmentConfigAccount =
			await makerClearingHouse.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);
		const txSig = await makerClearingHouse.fillSpotOrder(
			await takerClearingHouse.getUserAccountPublicKey(),
			takerClearingHouse.getUserAccount(),
			takerClearingHouse.getOrderByUserId(1),
			serumFulfillmentConfigAccount
		);

		await printTxLogs(connection, txSig);

		await takerClearingHouse.fetchAccounts();

		const takerQuoteSpotBalance = takerClearingHouse.getSpotPosition(0);
		const takerBaseSpotBalance = takerClearingHouse.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(199800000)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.balance,
			takerClearingHouse.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(0)));

		const takerOrder = takerClearingHouse.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerOrderFee.eq(new BN(100000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		assert(makerClearingHouse.getQuoteAssetTokenAmount().eq(new BN(20000)));

		const solSpotMarket =
			takerClearingHouse.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(116000)));
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		console.log(spotFeePoolAmount.toString());
		assert(spotFeePoolAmount.eq(new BN(108000)));

		await crankMarkets();
	});

	// check that moving referrer rebates works properly
	it('Fill bid second time', async () => {
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerClearingHouse.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);
		await takerClearingHouse.fetchAccounts();

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

		const serumFulfillmentConfigAccount =
			await makerClearingHouse.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);

		const txSig = await makerClearingHouse.fillSpotOrder(
			await takerClearingHouse.getUserAccountPublicKey(),
			takerClearingHouse.getUserAccount(),
			takerClearingHouse.getOrderByUserId(1),
			serumFulfillmentConfigAccount
		);

		await printTxLogs(connection, txSig);

		await takerClearingHouse.fetchAccounts();

		const takerQuoteSpotBalance = takerClearingHouse.getSpotPosition(0);
		const takerBaseSpotBalance = takerClearingHouse.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99700000))); // paid ~$.30

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.balance,
			takerClearingHouse.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerClearingHouse.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));
		assert(orderActionRecord.takerOrderFee.eq(new BN(100000)));

		const solSpotMarket =
			takerClearingHouse.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(174000)));
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		console.log(spotFeePoolAmount.toString());
		assert(spotFeePoolAmount.eq(new BN(166000)));

		await crankMarkets();
	});
});
