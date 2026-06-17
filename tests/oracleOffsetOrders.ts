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
} from '../packages/sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { calculateEntryPrice, PostOnlyParams } from '../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('oracle offset', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let fillerVelocityClient: TestClient;
	let fillerVelocityClientUser: User;

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

		solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
			undefined,
			10000
		);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }];

		fillerVelocityClient = new TestClient({
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
		await fillerVelocityClient.initialize(usdcMint.publicKey, true);
		await fillerVelocityClient.subscribe();
		await initializeQuoteSpotMarket(fillerVelocityClient, usdcMint.publicKey);
		await fillerVelocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerVelocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await fillerVelocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerVelocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerVelocityClientUser = new User({
			velocityClient: fillerVelocityClient,
			userAccountPublicKey:
				await fillerVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await fillerVelocityClientUser.subscribe();
	});

	beforeEach(async () => {
		await fillerVelocityClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd, 10000);
	});

	after(async () => {
		await fillerVelocityClient.unsubscribe();
		await fillerVelocityClientUser.unsubscribe();
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
		const velocityClient = new TestClient({
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
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

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
			oraclePriceOffset: priceOffset,
		});
		await velocityClient.placePerpOrder(orderParams);

		await fillerVelocityClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getOrderByUserOrderId(1);

		await fillerVelocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			order
		);

		await velocityClientUser.fetchAccounts();
		const position = velocityClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		const entryPrice = calculateEntryPrice(position);
		assert(breakEvenPrice.eq(new BN(910003)));
		assert(entryPrice.eq(new BN(909093)));

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
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
		const velocityClient = new TestClient({
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
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

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
			oraclePriceOffset: priceOffset,
		});

		await velocityClient.placePerpOrder(orderParams);

		await fillerVelocityClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getOrderByUserOrderId(1);

		await fillerVelocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClientUser.fetchAccounts();
		const position = velocityClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		console.log(breakEvenPrice.toString());
		const entryPrice = calculateEntryPrice(position);
		console.log(entryPrice.toString());
		const expectedBreakEvenPrice = new BN(949810);
		const expectedEntryPrice = new BN(950000);
		console.log(breakEvenPrice.toString(), 'vs', expectedEntryPrice.toString());
		assert(breakEvenPrice.eq(expectedBreakEvenPrice));
		assert(entryPrice.eq(expectedEntryPrice));

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
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
		const velocityClient = new TestClient({
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
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

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
			oraclePriceOffset: priceOffset,
		});
		await velocityClient.placePerpOrder(orderParams);

		await fillerVelocityClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getOrderByUserOrderId(1);

		await fillerVelocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClientUser.fetchAccounts();
		const position = velocityClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		const entryPrice = calculateEntryPrice(position);
		console.log(breakEvenPrice.toString());
		console.log(entryPrice.toString());
		assert(breakEvenPrice.eq(new BN(1098897)));
		assert(entryPrice.eq(new BN(1099997)));

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
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
		const velocityClient = new TestClient({
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
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

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
			oraclePriceOffset: priceOffset,
		});
		await velocityClient.placePerpOrder(orderParams);

		await fillerVelocityClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getOrderByUserOrderId(1);

		await fillerVelocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClientUser.fetchAccounts();
		const position = velocityClientUser.getPerpPosition(marketIndex);
		const breakEvenPrice = calculateBreakEvenPrice(position);
		const entryPrice = calculateEntryPrice(position);
		console.log(breakEvenPrice.toString());
		console.log(entryPrice.toString());
		const expectedEntryPrice = new BN(1050000);
		const expectedBreakEvenPrice = new BN(1050210);
		assert(breakEvenPrice.eq(expectedBreakEvenPrice));
		assert(entryPrice.eq(expectedEntryPrice));

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
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
		const velocityClient = new TestClient({
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
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

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
			oraclePriceOffset: priceOffset,
		});
		await velocityClient.placePerpOrder(orderParams);

		await velocityClientUser.fetchAccounts();
		const orderId = velocityClientUser.getUserAccount().orders[0].orderId;
		await velocityClient.cancelOrder(orderId);

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
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
		const velocityClient = new TestClient({
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
		await velocityClient.subscribe();
		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

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
			oraclePriceOffset: priceOffset,
		});
		await velocityClient.placePerpOrder(orderParams);

		await velocityClientUser.fetchAccounts();
		await velocityClient.cancelOrderByUserId(1);

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
	});
});
