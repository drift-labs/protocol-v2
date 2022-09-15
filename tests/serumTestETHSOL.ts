import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Transaction } from '@solana/web3.js';
const serumHelper = require('./serumHelper');
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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
	MARK_PRICE_PRECISION,
	SpotBalanceType,
	ZERO,
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	initializeEthSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	createFundedKeyPair,
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
	let ethOracle: PublicKey;

	let serumMarketPublicKey: PublicKey;

	let usdcMint;
	let wSolMint;
	let wEthMint;

	let makerUSDC;

	let takerClearingHouse: ClearingHouse;
	let takerWSOL: PublicKey;
	let takerUSDC: PublicKey;

	const usdcAmount = new BN(20000 * 10 ** 6);
	const solAmount = new BN(50 * 10 ** 9);
	const wSolAmount = new BN(2 * 10 ** 9);
	const wEthAmount = new BN(2 * 10 ** 9);

	let marketIndexes: BN[];
	let spotMarketIndexes: BN[];
	let oracleInfos: OracleInfo[];

	const solSpotMarketIndex = new BN(1);
	const ethSpotMarketIndex = new BN(2);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		wSolMint = await mockUSDCMint(provider);
		wEthMint = await mockUSDCMint(provider);

		makerUSDC = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		makerWSOL = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			solAmount
		);

		solOracle = await mockOracle(30);
		ethOracle = await mockOracle(1444);

		marketIndexes = [];
		spotMarketIndexes = [new BN(0), new BN(1), new BN(2)];
		oracleInfos = [
			{ publicKey: solOracle, source: OracleSource.PYTH },
			{ publicKey: ethOracle, source: OracleSource.PYTH },
		];

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

		await initializeSolSpotMarket(
			makerClearingHouse,
			solOracle,
			wSolMint.publicKey
		);
		await initializeEthSpotMarket(
			makerClearingHouse,
			ethOracle,
			wEthMint.publicKey
		);

		await makerClearingHouse.updateAuctionDuration(new BN(0), new BN(0));
		[takerClearingHouse, takerWSOL, takerUSDC] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				[new BN(0), new BN(1), new BN(2)],
				[
					{ publicKey: solOracle, source: OracleSource.PYTH },
					{ publicKey: ethOracle, source: OracleSource.PYTH },
				]
			);

		const takerWSOL2 = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			solAmount
		);

		await takerClearingHouse.deposit(usdcAmount, new BN(0), takerUSDC);
		// await takerClearingHouse.deposit(solAmount, new BN(1), takerWSOL2);
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
			baseMint: wEthMint.publicKey,
			quoteMint: wSolMint.publicKey,
			baseLotSize: 1000000,
			quoteLotSize: 1,
			dexProgramId: serumHelper.DEX_PID,
			feeRateBps: 0,
		});

		console.log('wEthMint.publicKey:', wEthMint.publicKey.toString());
		console.log('wSolMint.publicKey:', wSolMint.publicKey.toString());

		try {
			await makerClearingHouse.initializeSerumFulfillmentConfig(
				ethSpotMarketIndex,
				solSpotMarketIndex,
				serumMarketPublicKey,
				serumHelper.DEX_PID
			);
		} catch (e) {
			console.error(e);
		}
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
			makerClearingHouse.getSpotMarketAccount(ethSpotMarketIndex)
		);

		console.log('takerClearingHouse.placeSpotOrder');
		console.log('baseAssetAmount=', baseAssetAmount.toString());
		assert(ethSpotMarketIndex.eq(new BN(2)));
		assert(solSpotMarketIndex.eq(new BN(1)));

		try {
			await takerClearingHouse.placeSpotOrder(
				getLimitOrderParams({
					marketIndex: ethSpotMarketIndex,
					quoteSpotMarketIndex: solSpotMarketIndex,
					direction: PositionDirection.LONG,
					baseAssetAmount,
					userOrderId: 1,
					price: new BN(48).mul(MARK_PRICE_PRECISION),
				})
			);
		} catch (e) {
			console.error(e);
		}

		console.log('takerClearingHouse.placeSpotOrder finished');

		const spotOrder = takerClearingHouse.getOrderByUserId(1);

		assert(isVariant(spotOrder.marketType, 'spot'));
		assert(spotOrder.baseAssetAmount.eq(baseAssetAmount));

		assert(spotOrder.marketIndex.eq(ethSpotMarketIndex));
		assert(spotOrder.quoteSpotMarketIndex.eq(solSpotMarketIndex));

		await takerClearingHouse.fetchAccounts();
		const takerUser = takerClearingHouse.getUserAccount();
		console.log(takerUser.spotPositions);

		const usdcPosition = takerUser.spotPositions[0];
		const ethPosition = takerUser.spotPositions[1];
		const solPosition = takerUser.spotPositions[2];

		assert(ethPosition.marketIndex.eq(new BN(2)));
		assert(ethPosition.openOrders == 1);
		assert(ethPosition.openBids.gt(ZERO));

		assert(solPosition.marketIndex.eq(new BN(1)));
		assert(solPosition.openOrders == 1);
		assert(solPosition.openAsks.lt(ZERO));

		console.log('market.makePlaceOrderTransaction start');

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
				price: 48,
				size: 1,
				orderType: 'postOnly',
				clientId: undefined, // todo?
				openOrdersAddressKey: undefined,
				openOrdersAccount: undefined,
				feeDiscountPubkey: null,
				selfTradeBehavior: 'abortTransaction',
			}
		);
		console.log('market.makePlaceOrderTransaction');

		// try {
		await provider.sendAndConfirm(transaction, signers);
		// } catch (e) {
		// 	console.error(e);
		// }
		const serumFulfillmentConfigAccount =
			await makerClearingHouse.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);

		console.log('makerClearingHouse.fillSpotOrder');

		try {
			const txSig = await makerClearingHouse.fillSpotOrder(
				await takerClearingHouse.getUserAccountPublicKey(),
				takerClearingHouse.getUserAccount(),
				takerClearingHouse.getOrderByUserId(1),
				serumFulfillmentConfigAccount
			);

			await printTxLogs(connection, txSig);
		} catch (e) {
			console.error(e);
		}

		await takerClearingHouse.fetchAccounts();

		const takerUSDCSpotBalance = takerClearingHouse.getSpotPosition(0);
		const takerQuoteSpotBalance = takerClearingHouse.getSpotPosition(1);
		const takerBaseSpotBalance = takerClearingHouse.getSpotPosition(2);

		const usdcTokenAmount = getTokenAmount(
			takerUSDCSpotBalance.balance,
			takerClearingHouse.getQuoteSpotMarketAccount(),
			takerUSDCSpotBalance.balanceType
		);
		console.log('usdcTokenAmount:', usdcTokenAmount.toString());

		const quoteTokenAmount = getTokenAmount(
			takerQuoteSpotBalance.balance,
			takerClearingHouse.getSpotMarketAccount(1),
			takerQuoteSpotBalance.balanceType
		);
		console.log('quoteTokenAmount:', quoteTokenAmount.toString());
		// assert(quoteTokenAmount.eq(new BN(99900000)));

		const baseTokenAmount = getTokenAmount(
			takerBaseSpotBalance.balance,
			takerClearingHouse.getSpotMarketAccount(new BN(2)),
			takerBaseSpotBalance.balanceType
		);
		console.log('baseTokenAmount:', baseTokenAmount.toString());
		// assert(baseTokenAmount.eq(new BN(1000000000)));

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
			takerClearingHouse.getSpotMarketAccount(new BN(1)),
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

		console.log('takerClearingHouse.placeSpotOrder');
		await takerClearingHouse.placeSpotOrder(
			getLimitOrderParams({
				marketIndex: solSpotMarketIndex,
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

		console.log('market.makePlaceOrderTransaction');

		await provider.sendAndConfirm(transaction, signers);

		const serumFulfillmentConfigAccount =
			await makerClearingHouse.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);

		console.log('makerClearingHouse.fillSpotOrder');

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
			takerClearingHouse.getSpotMarketAccount(new BN(1)),
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
