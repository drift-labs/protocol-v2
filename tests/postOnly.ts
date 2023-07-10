import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	EventSubscriber,
	MarketStatus,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	BASE_PRECISION,
	BulkAccountLoader,
	calculateReservePrice,
	getLimitOrderParams,
	isVariant,
	OracleSource,
	PostOnlyParams,
	ZERO,
} from '../sdk';

describe('post only', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let fillerDriftClient: TestClient;
	let fillerDriftClientUser: User;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

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
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);

		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new TestClient({
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

		await fillerDriftClient.updatePerpMarketBaseSpread(0, 500);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerDriftClientUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
		});
		await fillerDriftClientUser.subscribe();
	});

	beforeEach(async () => {
		await fillerDriftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await fillerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
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
		});
		await driftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
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
		await driftClient.placePerpOrder(makerOrderParams);
		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		assert(order.postOnly);
		const newOraclePrice = 0.98;
		setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);

		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		assert(position.baseAssetAmount.eq(baseAssetAmount));
		console.log(position.quoteBreakEvenAmount.toString());
		assert(driftClient.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(driftClient.getUserStats().getAccount().fees.totalFeePaid.eq(ZERO));

		await fillerDriftClient.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(ZERO));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(19507)));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new TestClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
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
		});
		await driftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const reservePrice = calculateReservePrice(
			driftClient.getPerpMarketAccount(marketIndex),
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
		await driftClient.placePerpOrder(makerOrderParams);
		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getOrderByUserOrderId(1);

		assert(order.postOnly);

		const newOraclePrice = 1.02;
		setFeedPrice(anchor.workspace.Pyth, newOraclePrice, solUsd);
		await fillerDriftClient.moveAmmToPrice(
			marketIndex,
			new BN(newOraclePrice * PRICE_PRECISION.toNumber())
		);

		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const position = driftClientUser.getPerpPosition(marketIndex);
		assert(position.baseAssetAmount.abs().eq(baseAssetAmount));
		assert(position.quoteBreakEvenAmount.eq(new BN(1000000)));
		assert(driftClient.getQuoteAssetTokenAmount().eq(usdcAmount));
		assert(driftClient.getUserStats().getAccount().fees.totalFeePaid.eq(ZERO));

		await fillerDriftClient.fetchAccounts();
		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert(isVariant(orderRecord.action, 'fill'));
		assert(orderRecord.takerFee.eq(new BN(0)));
		assert(orderRecord.quoteAssetAmountSurplus.eq(new BN(19492)));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});
});
