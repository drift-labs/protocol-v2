import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	Wallet,
	getMarketOrderParams,
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
	getTriggerLimitOrderParams,
	OracleGuardRails,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import {
	BASE_PRECISION,
	convertToNumber,
	OracleSource,
	PERCENTAGE_PRECISION,
	QUOTE_PRECISION,
	ZERO,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('trigger orders', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let fillerDriftClient: TestClient;
	let fillerDriftClientUser: User;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

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
		oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH,
			},
		];

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

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION.mul(new BN(10)),
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION.mul(new BN(10)),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(55), // allow 55x change
			},
		};

		await fillerDriftClient.updateOracleGuardRails(oracleGuardRails);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

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

	it('stop market for long', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 0.49;
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('stop limit for long', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: PRICE_PRECISION.div(new BN(2)).sub(
				PRICE_PRECISION.div(new BN(50))
			),
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopLimitOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 0.49;
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('stop market for short', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.mul(new BN(2)),
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 2.01;
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('stop limit for short', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const triggerPrice = PRICE_PRECISION.mul(new BN(6)).div(new BN(5));
		const limitPrice = triggerPrice.add(PRICE_PRECISION.div(new BN(50)));
		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice,
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopLimitOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await driftClientUser.fetchAccounts();

		const totalCollateral0 = driftClientUser.getTotalCollateral();
		console.log(
			'user total collateral 0:',
			convertToNumber(totalCollateral0, QUOTE_PRECISION)
		);

		const newOraclePrice = 1.201;
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		await driftClientUser.fetchAccounts();

		const totalCollateral = driftClientUser.getTotalCollateral();
		console.log(
			'user total collateral after:',
			convertToNumber(totalCollateral, QUOTE_PRECISION)
		);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		// await printTxLogs(connection, txSig);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('take profit for long', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.mul(new BN(2)),
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.div(new BN(10)),
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 2.01, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('take profit limit for long', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const triggerPrice = PRICE_PRECISION.mul(new BN(2));
		const limitPrice = triggerPrice.sub(PRICE_PRECISION.div(new BN(50)));
		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice: triggerPrice,
			triggerCondition: OrderTriggerCondition.ABOVE,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopLimitOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 2.01;
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('take profit for short', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const stopOrderParams = getTriggerMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			triggerPrice: PRICE_PRECISION.div(new BN(2)),
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		await fillerDriftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(10)),
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 0.49, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('take profit limit for short', async () => {
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
			wallet: wallet,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION.mul(new BN(10));
		const marketOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(marketOrderParams);

		const triggerPrice = PRICE_PRECISION.div(new BN(2));
		const limitPrice = triggerPrice.add(PRICE_PRECISION.div(new BN(50)));
		const stopLimitOrderParams = getTriggerLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: limitPrice,
			triggerPrice: triggerPrice,
			triggerCondition: OrderTriggerCondition.BELOW,
			userOrderId: 1,
		});
		await driftClient.placePerpOrder(stopLimitOrderParams);

		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		try {
			// fill should fail since price is above trigger
			await fillerDriftClient.fillPerpOrder(
				await driftClientUser.getUserAccountPublicKey(),
				driftClientUser.getUserAccount(),
				order
			);
			assert(false);
		} catch (e) {
			// no op
		}

		const newOraclePrice = 0.49;
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);

		await fillerDriftClient.triggerOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClientUser.fetchAccounts();

		assert(
			driftClientUser.getUserAccount().perpPositions[0].baseAssetAmount.eq(ZERO)
		);

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});
});
