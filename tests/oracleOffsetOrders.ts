import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import { assert } from 'chai';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	getLimitOrderParams,
	MarketStatus,
	AMM_RESERVE_PRECISION,
	OracleSource,
	ZERO,
	calculateBreakEvenPrice,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { calculateEntryPrice, PostOnlyParams } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('oracle offset', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let fillerDriftClient: TestClient;
	let fillerDriftClientUser: User;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = 0;
	let solUsd;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

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
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new TestClient({
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
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await fillerDriftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerDriftClientUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerDriftClientUser.subscribe();
	});

	beforeEach(async () => {
		await fillerDriftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await fillerDriftClientUser.unsubscribe();
	});

	it('long taker', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = ZERO;
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20)).neg();

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			userOrderId: 1,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await driftClient.placePerpOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		const entryPrice = calculateEntryPrice(position);
		assert(breakEvenPrice.eq(new BN(910003)));
		assert(entryPrice.eq(new BN(909093)));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('long maker', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20)).neg();
		const price = ZERO; // oracle offsetoor

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			price,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			oraclePriceOffset: priceOffset.toNumber(),
		});

		await driftClient.placePerpOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		console.log(breakEvenPrice.toString());
		const entryPrice = calculateEntryPrice(position);
		console.log(entryPrice.toString());
		const expectedBreakEvenPrice = new BN(949810);
		const expectedEntryPrice = new BN(950000);
		console.log(breakEvenPrice.toString(), 'vs', expectedEntryPrice.toString());
		assert(breakEvenPrice.eq(expectedBreakEvenPrice));
		assert(entryPrice.eq(expectedEntryPrice));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('short taker', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO; // oracle offsetoor

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			price,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await driftClient.placePerpOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		const entryPrice = calculateEntryPrice(position);
		console.log(breakEvenPrice.toString());
		console.log(entryPrice.toString());
		assert(breakEvenPrice.eq(new BN(1098897)));
		assert(entryPrice.eq(new BN(1099997)));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('short maker', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			price,
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await driftClient.placePerpOrder(orderParams);

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		const entryPrice = calculateEntryPrice(position);
		console.log(breakEvenPrice.toString());
		console.log(entryPrice.toString());
		const expectedEntryPrice = new BN(1050000);
		const expectedBreakEvenPrice = new BN(1050210);
		assert(breakEvenPrice.eq(expectedBreakEvenPrice));
		assert(entryPrice.eq(expectedEntryPrice));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('cancel by order id', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await driftClient.placePerpOrder(orderParams);

		await driftClientUser.fetchAccounts();
		const orderId = driftClientUser.getUserAccount().orders[0].orderId;
		await driftClient.cancelOrder(orderId);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('cancel by user order id', async () => {
		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet,
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
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			userOrderId: 1,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await driftClient.placePerpOrder(orderParams);

		await driftClientUser.fetchAccounts();
		await driftClient.cancelOrderByUserId(1);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});
});
