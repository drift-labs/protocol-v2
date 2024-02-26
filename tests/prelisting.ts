import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	Wallet,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource, getDriftOraclePublicKey,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';
import { BulkAccountLoader, PEG_PRECISION, PostOnlyParams } from '../sdk';

describe('prelisting', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let adminDriftClient: TestClient;
	let adminDriftClientUser: User;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let solUsd;
	let driftOracle;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		driftOracle = getDriftOraclePublicKey(chProgram.programId, 0);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: driftOracle, source: OracleSource.DRIFT }];

		adminDriftClient = new TestClient({
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

		await adminDriftClient.initialize(usdcMint.publicKey, true);
		await adminDriftClient.subscribe();
		await initializeQuoteSpotMarket(adminDriftClient, usdcMint.publicKey);

		await adminDriftClient.initializeDriftOracle(0, PRICE_PRECISION.muln(32));

		const periodicity = new BN(0);
		await adminDriftClient.initializePerpMarket(
			0,
			driftOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32 * PEG_PRECISION.toNumber()),
			OracleSource.DRIFT,
		);

		await adminDriftClient.updatePerpAuctionDuration(0);

		await adminDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		adminDriftClientUser = new User({
			driftClient: adminDriftClient,
			userAccountPublicKey: await adminDriftClient.getUserAccountPublicKey(),
		});
		await adminDriftClientUser.subscribe();
	});

	after(async () => {
		await adminDriftClient.unsubscribe();
		await adminDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('trade', async () => {
		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const bidOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await adminDriftClient.placePerpOrder(bidOrderParams);
		await adminDriftClient.fetchAccounts();
		const bidOrder = adminDriftClientUser.getOrderByUserOrderId(1);

		await adminDriftClient.fillPerpOrder(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), bidOrder);

		await adminDriftClient.settlePNL(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), 0);

		const askOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(30).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(31).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(30).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await adminDriftClient.placePerpOrder(askOrderParams);
		await adminDriftClient.fetchAccounts();
		const askOrder = adminDriftClientUser.getOrderByUserOrderId(1);

		await adminDriftClient.fillPerpOrder(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), askOrder);

		const oraclePriceData = adminDriftClient.getOracleDataForPerpMarket(0);
		const oraclePrice = oraclePriceData.price;
		console.log(oraclePrice.toString());
	});

	// it('make', async () => {
	// 	const keypair = new Keypair();
	// 	await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
	// 	await sleep(1000);
	// 	const wallet = new Wallet(keypair);
	// 	const userUSDCAccount = await mockUserUSDCAccount(
	// 		usdcMint,
	// 		usdcAmount,
	// 		provider,
	// 		keypair.publicKey
	// 	);
	// 	const takerDriftClient = new TestClient({
	// 		connection,
	// 		wallet,
	// 		programID: chProgram.programId,
	// 		opts: {
	// 			commitment: 'confirmed',
	// 		},
	// 		activeSubAccountId: 0,
	// 		perpMarketIndexes: marketIndexes,
	// 		spotMarketIndexes: spotMarketIndexes,
	// 		oracleInfos,
	// 		userStats: true,
	// 		accountSubscription: {
	// 			type: 'polling',
	// 			accountLoader: bulkAccountLoader,
	// 		},
	// 	});
	// 	await takerDriftClient.subscribe();
	// 	await takerDriftClient.initializeUserAccountAndDepositCollateral(
	// 		usdcAmount,
	// 		userUSDCAccount.publicKey
	// 	);
	// 	const takerDriftClientUser = new User({
	// 		driftClient: takerDriftClient,
	// 		userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
	// 	});
	// 	await takerDriftClientUser.subscribe();
	//
	// 	const marketIndex = 0;
	// 	const baseAssetAmount = BASE_PRECISION;
	// 	const takerOrderParams = getLimitOrderParams({
	// 		marketIndex,
	// 		direction: PositionDirection.LONG,
	// 		baseAssetAmount,
	// 		price: new BN(34).mul(PRICE_PRECISION),
	// 		auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
	// 		auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
	// 		auctionDuration: 10,
	// 		userOrderId: 1,
	// 		postOnly: PostOnlyParams.NONE,
	// 	});
	// 	await takerDriftClient.placePerpOrder(takerOrderParams);
	// 	await takerDriftClientUser.fetchAccounts();
	// 	const order = takerDriftClientUser.getOrderByUserOrderId(1);
	// 	assert(!order.postOnly);
	//
	// 	const makerOrderParams = getLimitOrderParams({
	// 		marketIndex,
	// 		direction: PositionDirection.SHORT,
	// 		baseAssetAmount,
	// 		price: new BN(33).mul(PRICE_PRECISION),
	// 		userOrderId: 1,
	// 		postOnly: PostOnlyParams.MUST_POST_ONLY,
	// 		immediateOrCancel: true,
	// 	});
	//
	// 	const txSig = await makerDriftClient.placeAndMakePerpOrder(
	// 		makerOrderParams,
	// 		{
	// 			taker: await takerDriftClient.getUserAccountPublicKey(),
	// 			order: takerDriftClient.getOrderByUserId(1),
	// 			takerUserAccount: takerDriftClient.getUserAccount(),
	// 			takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
	// 		}
	// 	);
	//
	// 	await printTxLogs(connection, txSig);
	//
	// 	const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
	// 	assert(makerPosition.baseAssetAmount.eq(BASE_PRECISION.neg()));
	//
	// 	const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
	// 	assert(takerPosition.baseAssetAmount.eq(BASE_PRECISION));
	//
	// 	await takerDriftClientUser.unsubscribe();
	// 	await takerDriftClient.unsubscribe();
	// });
});
