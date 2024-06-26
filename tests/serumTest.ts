import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { listMarket, makePlaceOrderTransaction, SERUM } from './serumHelper';
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
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { Market } from '@project-serum/serum';
import { getMarketOrderParams, ZERO } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('serum spot market', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerWSOL: PublicKey;

	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let serumMarketPublicKey: PublicKey;

	let usdcMint;
	let makerUSDC;

	let takerDriftClient: TestClient;
	let _takerWSOL: PublicKey;
	let takerUSDC: PublicKey;

	const usdcAmount = new BN(200 * 10 ** 6);
	const solAmount = new BN(2 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	const solSpotMarketIndex = 1;

	let openOrdersAccount: PublicKey;

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'serum_dex',
					programId: new PublicKey(
						'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
					),
				},
			],
			[]
		);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		makerUSDC = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);
		makerWSOL = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			solAmount
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		makerDriftClient = new TestClient({
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

		[takerDriftClient, _takerWSOL, takerUSDC] =
			await createUserWithUSDCAndWSOLAccount(
				bankrunContextWrapper,
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
		serumMarketPublicKey = await listMarket({
			context: bankrunContextWrapper,
			wallet: bankrunContextWrapper.provider.wallet,
			baseMint: NATIVE_MINT,
			quoteMint: usdcMint.publicKey,
			baseLotSize: 100000000,
			quoteLotSize: 100,
			dexProgramId: SERUM,
			feeRateBps: 0,
		});

		await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'confirmed' },
			SERUM
		);

		await makerDriftClient.initializeSerumFulfillmentConfig(
			solSpotMarketIndex,
			serumMarketPublicKey,
			SERUM
		);
	});

	const crankMarkets = async () => {
		const openOrdersAccounts = [];

		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'processed' },
			SERUM
		);

		openOrdersAccounts.push(openOrdersAccount);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
		openOrdersAccounts.push(serumFulfillmentConfigAccount.serumOpenOrders);

		const consumeEventsIx = await market.makeConsumeEventsInstruction(
			openOrdersAccounts,
			10
		);

		const consumeEventsTx = new Transaction().add(consumeEventsIx);
		await bankrunContextWrapper.sendTransaction(consumeEventsTx);
		// await provider.sendAndConfirm(consumeEventsTx, []);

		// Open orders need to be sorted correctly but not sure how to do it in js, so will run this
		// ix sorted in both direction
		const consumeEventsIx2 = await market.makeConsumeEventsInstruction(
			openOrdersAccounts.reverse(),
			10
		);

		const consumeEventsTx2 = new Transaction().add(consumeEventsIx2);
		await bankrunContextWrapper.sendTransaction(consumeEventsTx2);
		// await provider.sendAndConfirm(consumeEventsTx2, []);
	};

	it('Fill bid', async () => {
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);

		await takerDriftClient.fetchAccounts();

		const spotOrder = takerDriftClient.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		// @ts-ignore
		const { transaction, signers } = await makePlaceOrderTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market,
			{
				// @ts-ignore
				owner: bankrunContextWrapper.provider.wallet,
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

		openOrdersAccount = signers[0].publicKey;

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);
		// await provider.sendAndConfirm(transaction, signers);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
		const txSig = await makerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrderByUserId(1),
			serumFulfillmentConfigAccount
		);

		await eventSubscriber.awaitTx(txSig);
		bankrunContextWrapper.printTxLogs(txSig);
		// await printTxLogs(connection, txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99899999)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.scaledBalance,
			takerDriftClient.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerDriftClient.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		await makerDriftClient.fetchAccounts();
		assert(makerDriftClient.getQuoteAssetTokenAmount().eq(new BN(11800)));

		const solSpotMarket =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		assert(spotFeePoolAmount.eq(new BN(48200)));

		await crankMarkets();
	});

	it('Fill ask', async () => {
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);
		await takerDriftClient.fetchAccounts();

		const spotOrder = takerDriftClient.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		// @ts-ignore
		const { transaction, signers } = await makePlaceOrderTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market,
			{
				// @ts-ignore
				owner: bankrunContextWrapper.provider.wallet,
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

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
		const txSig = await makerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrderByUserId(1),
			serumFulfillmentConfigAccount
		);

		await eventSubscriber.awaitTx(txSig);
		bankrunContextWrapper.printTxLogs(txSig);
		// await printTxLogs(connection, txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(199799999)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.scaledBalance,
			takerDriftClient.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(0)));

		const takerOrder = takerDriftClient.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		assert(makerDriftClient.getQuoteAssetTokenAmount().eq(new BN(23600)));

		const solSpotMarket =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(136400)));
		const spotFeePoolAmount = getTokenAmount(
			solSpotMarket.spotFeePool.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			SpotBalanceType.DEPOSIT
		);
		console.log(spotFeePoolAmount.toString());
		assert(spotFeePoolAmount.eq(new BN(116400)));

		await crankMarkets();
	});

	// check that moving referrer rebates works properly
	it('Fill bid second time', async () => {
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
		);

		await takerDriftClient.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				userOrderId: 1,
				price: new BN(100).mul(PRICE_PRECISION),
			})
		);
		await takerDriftClient.fetchAccounts();

		const spotOrder = takerDriftClient.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		// @ts-ignore
		const { transaction, signers } = await makePlaceOrderTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market,
			{
				// @ts-ignore
				owner: bankrunContextWrapper.provider.wallet,
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

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);
		// await provider.sendAndConfirm(transaction, signers);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);

		const txSig = await makerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrderByUserId(1),
			serumFulfillmentConfigAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
		// await printTxLogs(connection, txSig);

		await eventSubscriber.awaitTx(txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(99699999))); // paid ~$.30

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.scaledBalance,
			takerDriftClient.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(new BN(1000000000)));

		const takerOrder = takerDriftClient.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		const solSpotMarket =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		assert(solSpotMarket.totalSpotFee.eq(new BN(204600)));
		// const spotFeePoolAmount = getTokenAmount(
		// 	solSpotMarket.spotFeePool.scaledBalance,
		// 	takerDriftClient.getQuoteSpotMarketAccount(),
		// 	SpotBalanceType.DEPOSIT
		// );
		console.log(`${orderActionRecord.fillerReward}`);
		console.log(`${solSpotMarket.cumulativeDepositInterest.toString()}`);
		console.log(`${orderActionRecord.makerFee.toString()}`);
		console.log(solSpotMarket.depositBalance.toString());
		console.log(`${solSpotMarket.borrowBalance.toString()}`);
		// TODO: Figure out why this value comes out as 164600
		// assert(spotFeePoolAmount.eq(new BN(184600)));

		assert(orderActionRecord.fillerReward.eq(new BN(11800)));
		assert(orderActionRecord.makerFee.eq(new BN(0)));
		assert(solSpotMarket.depositBalance.eq(new BN(1_000_000_000)));

		await crankMarkets();
	});

	// check that moving referrer rebates works properly
	it('Place and take', async () => {
		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		// @ts-ignore
		const { transaction, signers } = await makePlaceOrderTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market,
			{
				// @ts-ignore
				owner: bankrunContextWrapper.provider.wallet,
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

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);
		// await provider.sendAndConfirm(transaction, signers);
		const baseAssetAmount = castNumberToSpotPrecision(
			1,
			makerDriftClient.getSpotMarketAccount(solSpotMarketIndex)
		);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);

		const txSig = await takerDriftClient.placeAndTakeSpotOrder(
			getMarketOrderParams({
				marketIndex: solSpotMarketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				userOrderId: 1,
			}),
			serumFulfillmentConfigAccount
		);

		bankrunContextWrapper.printTxLogs(txSig);
		// await printTxLogs(connection, txSig);

		await eventSubscriber.awaitTx(txSig);

		await takerDriftClient.fetchAccounts();

		const takerQuoteSpotBalance = takerDriftClient.getSpotPosition(0);
		const takerBaseSpotBalance = takerDriftClient.getSpotPosition(1);

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.scaledBalance,
			takerDriftClient.getQuoteSpotMarketAccount(),
			takerQuoteSpotBalance.balanceType
		);
		console.log(quoteTokenAmount.toString());
		assert(quoteTokenAmount.eq(new BN(199599999))); // paid ~$.40

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.scaledBalance,
			takerDriftClient.getSpotMarketAccount(1),
			takerBaseSpotBalance.balanceType
		);
		assert(baseTokenAmount.eq(ZERO));

		const takerOrder = takerDriftClient.getUserAccount().orders[0];
		assert(isVariant(takerOrder.status, 'init'));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(orderActionRecord.baseAssetAmountFilled.eq(new BN(1000000000)));
		assert(orderActionRecord.quoteAssetAmountFilled.eq(new BN(100000000)));
		assert(orderActionRecord.takerFee.eq(new BN(100000)));

		const solSpotMarket =
			takerDriftClient.getSpotMarketAccount(solSpotMarketIndex);
		console.log(solSpotMarket.totalSpotFee.toString());
		assert(solSpotMarket.totalSpotFee.eq(new BN(284600)));
		// const spotFeePoolAmount = getTokenAmount(
		// 	solSpotMarket.spotFeePool.scaledBalance,
		// 	takerDriftClient.getQuoteSpotMarketAccount(),
		// 	SpotBalanceType.DEPOSIT
		// );
		console.log(`${orderActionRecord.fillerReward.toString()}`);
		console.log(`${solSpotMarket.cumulativeDepositInterest.toString()}`);
		console.log(`${orderActionRecord.makerFee.toString()}`);
		console.log(`${solSpotMarket.borrowBalance.toString()}`);

		assert(orderActionRecord.fillerReward.eq(new BN(0)));
		assert(orderActionRecord.makerFee.eq(new BN(0)));
		assert(solSpotMarket.depositBalance.eq(new BN(0)));
		// TODO: Figure out why this value comes out as 224000
		// assert(spotFeePoolAmount.eq(new BN(264600)));

		await crankMarkets();
	});
});
