import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Account, PublicKey, Transaction } from '@solana/web3.js';
const serumHelper = require('./serumHelper');

import {
	BN,
	TestClient,
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
import { DexInstructions, Market, OpenOrders } from '@project-serum/serum';
import {
	BulkAccountLoader,
	getMarketOrderParams,
	getSerumSignerPublicKey,
	QUOTE_PRECISION,
	ZERO,
} from '../sdk';

describe('spot swap', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		skipPreflight: false,
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerWSOL: PublicKey;

	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let solOracle: PublicKey;

	let serumMarketPublicKey: PublicKey;

	let usdcMint;
	let makerUSDC;

	let takerDriftClient: TestClient;
	let takerWSOL: PublicKey;
	let takerUSDC: PublicKey;
	let takerOpenOrders: PublicKey;

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

		makerDriftClient = new TestClient({
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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await makerDriftClient.initialize(usdcMint.publicKey, true);
		await makerDriftClient.subscribe();
		await makerDriftClient.initializeUserAccount();

		await initializeQuoteSpotMarket(makerDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(makerDriftClient, solOracle);
		await makerDriftClient.updateSpotMarketStepSizeAndTickSize(
			1,
			new BN(100000000),
			new BN(100)
		);
		await makerDriftClient.updateSpotAuctionDuration(0);

		[takerDriftClient, takerWSOL, takerUSDC] =
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
				],
				bulkAccountLoader
			);

		await takerDriftClient.deposit(usdcAmount, 0, takerUSDC);
	});

	after(async () => {
		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
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

		await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'confirmed' },
			serumHelper.DEX_PID
		);

		await makerDriftClient.initializeSerumFulfillmentConfig(
			solSpotMarketIndex,
			serumMarketPublicKey,
			serumHelper.DEX_PID
		);

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		const openOrdersAccount = new Account();
		const createOpenOrdersIx = await OpenOrders.makeCreateAccountTransaction(
			connection,
			market.address,
			takerDriftClient.wallet.publicKey,
			openOrdersAccount.publicKey,
			market.programId
		);
		await takerDriftClient.sendTransaction(
			new Transaction().add(createOpenOrdersIx),
			[openOrdersAccount]
		);

		takerOpenOrders = openOrdersAccount.publicKey;
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
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
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

	it('swap usdc for sol', async () => {
		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		// place ask to sell 1 sol for 100 usdc
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

		const outAmount = new BN(100).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			outAmount,
			outMarketIndex: 0,
			inMarketIndex: 1,
			outTokenAccount: takerUSDC,
			inTokenAccount: takerWSOL,
		});

		// @ts-ignore
		const serumBidIx = await market.makePlaceOrderInstruction(connection, {
			// @ts-ignore
			owner: takerDriftClient.wallet,
			payer: takerUSDC,
			side: 'buy',
			price: 100,
			size: 1,
			orderType: 'limit',
			clientId: undefined, // todo?
			openOrdersAddressKey: takerOpenOrders,
			feeDiscountPubkey: null,
			selfTradeBehavior: 'abortTransaction',
		});

		const serumConfig = await takerDriftClient.getSerumV3FulfillmentConfig(
			market.publicKey
		);
		const settleFundsIx = DexInstructions.settleFunds({
			market: market.publicKey,
			openOrders: takerOpenOrders,
			owner: takerDriftClient.wallet.publicKey,
			// @ts-ignore
			baseVault: serumConfig.serumBaseVault,
			// @ts-ignore
			quoteVault: serumConfig.serumQuoteVault,
			baseWallet: takerWSOL,
			quoteWallet: takerUSDC,
			vaultSigner: getSerumSignerPublicKey(
				market.programId,
				market.publicKey,
				serumConfig.serumSignerNonce
			),
			programId: market.programId,
		});

		const tx = new Transaction()
			.add(beginSwapIx)
			.add(serumBidIx)
			.add(settleFundsIx)
			.add(endSwapIx);

		const { txSig } = await takerDriftClient.sendTransaction(tx);

		await printTxLogs(connection, txSig);

		const takerSOLAmount = await takerDriftClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(900000000)));
		const takerUSDCAmount = await takerDriftClient.getTokenAmount(0);
		assert(takerUSDCAmount.eq(new BN(109964000)));

		//
		// await provider.sendAndConfirm(transaction, signers);
		//
		// const serumFulfillmentConfigAccount =
		// 	await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
		// const txSig = await makerDriftClient.fillSpotOrder(
		// 	await takerDriftClient.getUserAccountPublicKey(),
		// 	takerDriftClient.getUserAccount(),
		// 	takerDriftClient.getOrderByUserId(1),
		// 	serumFulfillmentConfigAccount
		// );
		//
		// await eventSubscriber.awaitTx(txSig);
		//
		// await printTxLogs(connection, txSig);
		//
		// await takerDriftClient.fetchAccounts();
		//
		// const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		// const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);
		//
		// const quoteTokenAmount = getTokenAmount(
		// 	takerQuoteSpotBalance.scaledBalance,
		// 	takerDriftClient.getQuoteSpotMarketAccount(),
		// 	takerQuoteSpotBalance.balanceType
		// );
		// console.log(quoteTokenAmount.toString());
		// assert(quoteTokenAmount.eq(new BN(99900000)));
		//
		// const baseTokenAmount = getTokenAmount(
		// 	takerBaseSpotBalance.scaledBalance,
		// 	takerDriftClient.getSpotMarketAccount(1),
		// 	takerBaseSpotBalance.balanceType
		// );
		// assert(baseTokenAmount.eq(new BN(1000000000)));
		//
		// const takerOrder = takerDriftClient.getUserAccount().orders[0];
		// assert(isVariant(takerOrder.status, 'init'));
		//
		// const orderActionRecord =
		// 	eventSubscriber.getEventsArray('OrderActionRecord')[0];
		// assert(isVariant(orderActionRecord.action, 'fill'));
		// assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		// assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		// assert(orderActionRecord.takerFee.eq(new BN(100000)));
		//
		// await makerDriftClient.fetchAccounts();
		// assert(makerDriftClient.getQuoteAssetTokenAmount().eq(new BN(11800)));
		//
		// const solSpotMarket =
		// 	takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		// const spotFeePoolAmount = getTokenAmount(
		// 	solSpotMarket.spotFeePool.scaledBalance,
		// 	takerDriftClient.getQuoteSpotMarketAccount(),
		// 	SpotBalanceType.DEPOSIT
		// );
		// assert(spotFeePoolAmount.eq(new BN(48200)));
		//
		// await crankMarkets();
	});

	// it('Fill ask', async () => {
	// 	const baseAssetAmount = castNumberToSpotPrecision(
	// 		1,
	// 		makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
	// 	);
	//
	// 	await takerDriftClient.placeSpotOrder(
	// 		getLimitOrderParams({
	// 			marketIndex: solSpotMarketIndex,
	// 			direction: PositionDirection.SHORT,
	// 			baseAssetAmount,
	// 			userOrderId: 1,
	// 			price: new BN(100).mul(PRICE_PRECISION),
	// 		})
	// 	);
	// 	await takerDriftClient.fetchAccounts();
	//
	// 	const spotOrder = takerDriftClient.getOrderByUserId(1);
	//
	// 	assert(isVariant(spotOrder.marketType, 'spot'));
	// 	assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));
	//
	// 	const market = await Market.load(
	// 		provider.connection,
	// 		serumMarketPublicKey,
	// 		{ commitment: 'recent' },
	// 		serumHelper.DEX_PID
	// 	);
	//
	// 	// @ts-ignore
	// 	const { transaction, signers } = await market.makePlaceOrderTransaction(
	// 		provider.connection,
	// 		{
	// 			// @ts-ignore
	// 			owner: provider.wallet,
	// 			payer: makerUSDC.publicKey,
	// 			side: 'buy',
	// 			price: 100,
	// 			size: 1,
	// 			orderType: 'postOnly',
	// 			clientId: undefined, // todo?
	// 			openOrdersAddressKey: undefined,
	// 			openOrdersAccount: undefined,
	// 			feeDiscountPubkey: null,
	// 			selfTradeBehavior: 'abortTransaction',
	// 		}
	// 	);
	//
	// 	await provider.sendAndConfirm(transaction, signers);
	//
	// 	const serumFulfillmentConfigAccount =
	// 		await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
	// 	const txSig = await makerDriftClient.fillSpotOrder(
	// 		await takerDriftClient.getUserAccountPublicKey(),
	// 		takerDriftClient.getUserAccount(),
	// 		takerDriftClient.getOrderByUserId(1),
	// 		serumFulfillmentConfigAccount
	// 	);
	//
	// 	await eventSubscriber.awaitTx(txSig);
	//
	// 	await printTxLogs(connection, txSig);
	//
	// 	await takerDriftClient.fetchAccounts();
	//
	// 	const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
	// 	const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);
	//
	// 	const quoteTokenAmount = getTokenAmount(
	// 		takerQuoteSpotBalance.scaledBalance,
	// 		takerDriftClient.getQuoteSpotMarketAccount(),
	// 		takerQuoteSpotBalance.balanceType
	// 	);
	// 	console.log(quoteTokenAmount.toString());
	// 	assert(quoteTokenAmount.eq(new BN(199800000)));
	//
	// 	const baseTokenAmount = getTokenAmount(
	// 		takerBaseSpotBalance.scaledBalance,
	// 		takerDriftClient.getSpotMarketAccount(1),
	// 		takerBaseSpotBalance.balanceType
	// 	);
	// 	assert(baseTokenAmount.eq(new BN(0)));
	//
	// 	const takerOrder = takerDriftClient.getUserAccount().orders[0];
	// 	assert(isVariant(takerOrder.status, 'init'));
	//
	// 	const orderActionRecord =
	// 		eventSubscriber.getEventsArray('OrderActionRecord')[0];
	// 	assert(isVariant(orderActionRecord.action, 'fill'));
	// 	assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
	// 	assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
	// 	assert(orderActionRecord.takerFee.eq(new BN(100000)));
	//
	// 	assert(makerDriftClient.getQuoteAssetTokenAmount().eq(new BN(23600)));
	//
	// 	const solSpotMarket =
	// 		takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
	// 	assert(solSpotMarket.totalSpotFee.eq(new BN(136400)));
	// 	const spotFeePoolAmount = getTokenAmount(
	// 		solSpotMarket.spotFeePool.scaledBalance,
	// 		takerDriftClient.getQuoteSpotMarketAccount(),
	// 		SpotBalanceType.DEPOSIT
	// 	);
	// 	console.log(spotFeePoolAmount.toString());
	// 	assert(spotFeePoolAmount.eq(new BN(116400)));
	//
	// 	await crankMarkets();
	// });
	//
	// // check that moving referrer rebates works properly
	// it('Fill bid second time', async () => {
	// 	const baseAssetAmount = castNumberToSpotPrecision(
	// 		1,
	// 		makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
	// 	);
	//
	// 	await takerDriftClient.placeSpotOrder(
	// 		getLimitOrderParams({
	// 			marketIndex: solSpotMarketIndex,
	// 			direction: PositionDirection.LONG,
	// 			baseAssetAmount,
	// 			userOrderId: 1,
	// 			price: new BN(100).mul(PRICE_PRECISION),
	// 		})
	// 	);
	// 	await takerDriftClient.fetchAccounts();
	//
	// 	const spotOrder = takerDriftClient.getOrderByUserId(1);
	//
	// 	assert(isVariant(spotOrder.marketType, 'spot'));
	// 	assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));
	//
	// 	const market = await Market.load(
	// 		provider.connection,
	// 		serumMarketPublicKey,
	// 		{ commitment: 'recent' },
	// 		serumHelper.DEX_PID
	// 	);
	//
	// 	// @ts-ignore
	// 	const { transaction, signers } = await market.makePlaceOrderTransaction(
	// 		provider.connection,
	// 		{
	// 			// @ts-ignore
	// 			owner: provider.wallet,
	// 			payer: makerWSOL,
	// 			side: 'sell',
	// 			price: 100,
	// 			size: 1,
	// 			orderType: 'postOnly',
	// 			clientId: undefined, // todo?
	// 			openOrdersAddressKey: undefined,
	// 			openOrdersAccount: undefined,
	// 			feeDiscountPubkey: null,
	// 			selfTradeBehavior: 'abortTransaction',
	// 		}
	// 	);
	//
	// 	await provider.sendAndConfirm(transaction, signers);
	//
	// 	const serumFulfillmentConfigAccount =
	// 		await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
	//
	// 	const txSig = await makerDriftClient.fillSpotOrder(
	// 		await takerDriftClient.getUserAccountPublicKey(),
	// 		takerDriftClient.getUserAccount(),
	// 		takerDriftClient.getOrderByUserId(1),
	// 		serumFulfillmentConfigAccount
	// 	);
	//
	// 	await printTxLogs(connection, txSig);
	//
	// 	await eventSubscriber.awaitTx(txSig);
	//
	// 	await takerDriftClient.fetchAccounts();
	//
	// 	const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
	// 	const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);
	//
	// 	const quoteTokenAmount = getTokenAmount(
	// 		takerQuoteSpotBalance.scaledBalance,
	// 		takerDriftClient.getQuoteSpotMarketAccount(),
	// 		takerQuoteSpotBalance.balanceType
	// 	);
	// 	console.log(quoteTokenAmount.toString());
	// 	assert(quoteTokenAmount.eq(new BN(99700000))); // paid ~$.30
	//
	// 	const baseTokenAmount = getTokenAmount(
	// 		takerBaseSpotBalance.scaledBalance,
	// 		takerDriftClient.getSpotMarketAccount(1),
	// 		takerBaseSpotBalance.balanceType
	// 	);
	// 	assert(baseTokenAmount.eq(new BN(1000000000)));
	//
	// 	const takerOrder = takerDriftClient.getUserAccount().orders[0];
	// 	assert(isVariant(takerOrder.status, 'init'));
	//
	// 	const orderActionRecord =
	// 		eventSubscriber.getEventsArray('OrderActionRecord')[0];
	// 	assert(isVariant(orderActionRecord.action, 'fill'));
	// 	assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
	// 	assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
	// 	assert(orderActionRecord.takerFee.eq(new BN(100000)));
	//
	// 	const solSpotMarket =
	// 		takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
	// 	assert(solSpotMarket.totalSpotFee.eq(new BN(204600)));
	// 	const spotFeePoolAmount = getTokenAmount(
	// 		solSpotMarket.spotFeePool.scaledBalance,
	// 		takerDriftClient.getQuoteSpotMarketAccount(),
	// 		SpotBalanceType.DEPOSIT
	// 	);
	// 	assert(spotFeePoolAmount.eq(new BN(184600)));
	//
	// 	await crankMarkets();
	// });
	//
	// // check that moving referrer rebates works properly
	// it('Place and take', async () => {
	// 	const market = await Market.load(
	// 		provider.connection,
	// 		serumMarketPublicKey,
	// 		{ commitment: 'recent' },
	// 		serumHelper.DEX_PID
	// 	);
	//
	// 	// @ts-ignore
	// 	const { transaction, signers } = await market.makePlaceOrderTransaction(
	// 		provider.connection,
	// 		{
	// 			// @ts-ignore
	// 			owner: provider.wallet,
	// 			payer: makerUSDC.publicKey,
	// 			side: 'buy',
	// 			price: 100,
	// 			size: 1,
	// 			orderType: 'postOnly',
	// 			clientId: undefined, // todo?
	// 			openOrdersAddressKey: undefined,
	// 			openOrdersAccount: undefined,
	// 			feeDiscountPubkey: null,
	// 			selfTradeBehavior: 'abortTransaction',
	// 		}
	// 	);
	//
	// 	await provider.sendAndConfirm(transaction, signers);
	// 	const baseAssetAmount = castNumberToSpotPrecision(
	// 		1,
	// 		makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
	// 	);
	//
	// 	const serumFulfillmentConfigAccount =
	// 		await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
	//
	// 	const txSig = await takerDriftClient.placeAndTakeSpotOrder(
	// 		getMarketOrderParams({
	// 			marketIndex: solSpotMarketIndex,
	// 			direction: PositionDirection.SHORT,
	// 			baseAssetAmount,
	// 			userOrderId: 1,
	// 		}),
	// 		serumFulfillmentConfigAccount
	// 	);
	//
	// 	await printTxLogs(connection, txSig);
	//
	// 	await eventSubscriber.awaitTx(txSig);
	//
	// 	await takerDriftClient.fetchAccounts();
	//
	// 	const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
	// 	const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);
	//
	// 	const quoteTokenAmount = getTokenAmount(
	// 		takerQuoteSpotBalance.scaledBalance,
	// 		takerDriftClient.getQuoteSpotMarketAccount(),
	// 		takerQuoteSpotBalance.balanceType
	// 	);
	// 	console.log(quoteTokenAmount.toString());
	// 	assert(quoteTokenAmount.eq(new BN(199600000))); // paid ~$.40
	//
	// 	const baseTokenAmount = getTokenAmount(
	// 		takerBaseSpotBalance.scaledBalance,
	// 		takerDriftClient.getSpotMarketAccount(1),
	// 		takerBaseSpotBalance.balanceType
	// 	);
	// 	assert(baseTokenAmount.eq(ZERO));
	//
	// 	const takerOrder = takerDriftClient.getUserAccount().orders[0];
	// 	assert(isVariant(takerOrder.status, 'init'));
	//
	// 	const orderActionRecord =
	// 		eventSubscriber.getEventsArray('OrderActionRecord')[0];
	// 	assert(isVariant(orderActionRecord.action, 'fill'));
	// 	assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
	// 	assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
	// 	assert(orderActionRecord.takerFee.eq(new BN(100000)));
	//
	// 	const solSpotMarket =
	// 		takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
	// 	console.log(solSpotMarket.totalSpotFee.toString());
	// 	assert(solSpotMarket.totalSpotFee.eq(new BN(284600)));
	// 	const spotFeePoolAmount = getTokenAmount(
	// 		solSpotMarket.spotFeePool.scaledBalance,
	// 		takerDriftClient.getQuoteSpotMarketAccount(),
	// 		SpotBalanceType.DEPOSIT
	// 	);
	// 	console.log(spotFeePoolAmount.toString());
	// 	assert(spotFeePoolAmount.eq(new BN(264600)));
	//
	// 	await crankMarkets();
	// });
});
