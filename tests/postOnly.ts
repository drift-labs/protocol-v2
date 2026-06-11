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
	EventSubscriber,
	MarketStatus,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import {
	BASE_PRECISION,
	calculateReservePrice,
	getLimitOrderParams,
	isVariant,
	OracleSource,
	PostOnlyParams,
	ZERO,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('post only', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let fillerVelocityClient: TestClient;
	let fillerVelocityClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
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

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);

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

		await fillerVelocityClient.updatePerpMarketBaseSpread(0, 500);

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
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);
	});

	after(async () => {
		await fillerVelocityClient.unsubscribe();
		await fillerVelocityClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('long', async () => {
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
			userStats: true,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			velocityClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: reservePrice,
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
		});
		await velocityClient.placePerpOrder(makerOrderParams);
		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		const newOraclePrice = 0.98;
		setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);
		await fillerVelocityClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);

		await fillerVelocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();
		const position = velocityClientUser.getPerpPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		console.log(position.quoteBreakEvenAmount.toString());
		assert(velocityClient.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(
			velocityClient.getUserStats().getAccount().fees.totalFeePaid.eq(ZERO)
		);

		await fillerVelocityClient.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(19507)));

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
	});

	it('short', async () => {
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
			userStats: true,
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

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			velocityClient.getPerpMarketAccount(marketIndex),
			undefined
		);
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: reservePrice,
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
		});
		await velocityClient.placePerpOrder(makerOrderParams);
		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getOrderByUserOrderId(1);

		assert(order.postOnly);

		const newOraclePrice = 1.02;
		setFeedPriceNoProgram(bankrunContextWrapper, newOraclePrice, solUsd);
		await fillerVelocityClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);

		await fillerVelocityClient.fillPerpOrder(
			await velocityClientUser.getUserAccountPublicKey(),
			velocityClientUser.getUserAccount(),
			order
		);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();
		const position = velocityClientUser.getPerpPosition(marketIndex);
		assert(position.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(position.quoteBreakEvenAmount.eq(new BN(1000200)));
		assert(velocityClient.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(
			velocityClient.getUserStats().getAccount().fees.totalFeePaid.eq(ZERO)
		);
		assert(
			velocityClient
				.getUserStats()
				.getAccount()
				.fees.totalFeeRebate.eq(new BN(200))
		);

		await fillerVelocityClient.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(new BN(0)));
		console.log(orderRecord.quoteAssetAmountSurplus.toString());
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(19492)));

		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
	});
});
