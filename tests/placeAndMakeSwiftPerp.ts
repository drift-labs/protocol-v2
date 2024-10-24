import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	Keypair,
	PublicKey,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';

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
	OracleSource,
	BulkAccountLoader,
	SwiftOrderParamsMessage,
	SwiftServerMessage,
	loadKeypair,
	getMarketOrderParams,
	MarketType,
	SwiftOrderRecord,
	DriftClient,
	ANCHOR_TEST_SWIFT_ID,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	printTxLogs,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpersLocalValidator';
import { PEG_PRECISION, PostOnlyParams } from '../sdk/src';
import dotenv from 'dotenv';
dotenv.config();

describe('place and make swift order', () => {
	if (!process.env.SWIFT_PRIVATE_KEY) {
		throw new Error('SWIFT_PRIVATE_KEY not set');
	}

	const swiftKeypair = loadKeypair(process.env.SWIFT_PRIVATE_KEY);

	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerDriftClientUser: User;
	//@ts-ignore
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
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		await provider.connection.requestAirdrop(
			provider.wallet.publicKey,
			10 ** 9
		);

		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(32.821);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		makerDriftClient = new TestClient({
			connection,
			//@ts-ignore
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
			swiftID: new PublicKey(ANCHOR_TEST_SWIFT_ID),
		});
		await makerDriftClient.initialize(usdcMint.publicKey, true);
		await makerDriftClient.subscribe();
		await initializeQuoteSpotMarket(makerDriftClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await makerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32 * PEG_PRECISION.toNumber())
		);

		await makerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		makerDriftClientUser = new User({
			driftClient: makerDriftClient,
			userAccountPublicKey: await makerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerDriftClientUser.subscribe();
	});

	after(async () => {
		await makerDriftClient.unsubscribe();
		await makerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('should succeed on correct sig', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new TestClient({
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
			swiftID: new PublicKey(ANCHOR_TEST_SWIFT_ID),
		});
		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount: baseAssetAmount.muln(2),
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
			marketType: MarketType.PERP,
		});
		const takerOrderParamsMessage: SwiftOrderParamsMessage = {
			swiftOrderParams: takerOrderParams,
			expectedOrderId: 1,
			subAccountId: 0,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		await takerDriftClientUser.fetchAccounts();

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
			price: new BN(33).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const takerOrderParamsSig = takerDriftClient.signSwiftOrderParamsMessage(
			takerOrderParamsMessage
		);

		const swiftServerMessage: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig,
		};

		const encodedSwiftServerMessage =
			makerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = makerDriftClient.signMessage(
			Uint8Array.from(encodedSwiftServerMessage),
			swiftKeypair
		);

		const ixs = await makerDriftClient.getPlaceAndMakeSwiftPerpOrderIxs(
			encodedSwiftServerMessage,
			swiftSignature,
			takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
			takerOrderParamsSig,
			takerOrderParamsMessage.expectedOrderId,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			},
			makerOrderParams
		);

		try {
			const message = new TransactionMessage({
				instructions: ixs,
				payerKey: makerDriftClient.wallet.payer.publicKey,
				recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
			}).compileToV0Message();
			const tx = new VersionedTransaction(message);
			const simResult = await provider.connection.simulateTransaction(tx);
			console.log(simResult.value.logs);

			const txSig = await makerDriftClient.sendTransaction(
				new Transaction().add(...ixs)
			);
			await printTxLogs(provider.connection, txSig.txSig);
		} catch (e: any) {
			console.log(e);
			// console.log(await e.getLogs());
		}

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(BASE_PRECISION.neg()));

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(BASE_PRECISION));

		// Mkae sure that the event is in the logs
		const events = eventSubscriber.getEventsByTx(txSig);
		const event = events.find((event) => event.eventType == 'SwiftOrderRecord');
		assert(event !== undefined);
		assert((event as SwiftOrderRecord).userNextOrderId == 1);

		console.log('######################################');

		await makerDriftClient.placeAndMakeSwiftPerpOrder(
			encodedSwiftServerMessage,
			swiftSignature,
			takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
			takerOrderParamsSig,
			takerOrderParamsMessage.expectedOrderId,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			},
			makerOrderParams
		);

		const takerPositionAfter = takerDriftClient.getUser().getPerpPosition(0);
		const makerPositionAfter = makerDriftClient.getUser().getPerpPosition(0);

		assert(takerPositionAfter.baseAssetAmount.eq(baseAssetAmount.muln(2)));
		assert(
			makerPositionAfter.baseAssetAmount.eq(baseAssetAmount.muln(2).neg())
		);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should fail on bad order params sig', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new DriftClient({
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
		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
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

		await takerDriftClientUser.fetchAccounts();
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(33).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});

		const takerOrderParamsMessage: SwiftOrderParamsMessage = {
			swiftOrderParams: takerOrderParams,
			expectedOrderId: 1,
			takeProfitOrderParams: null,
			subAccountId: 0,
			stopLossOrderParams: null,
		};
		const takerOrderParamsSig = makerDriftClient.signSwiftOrderParamsMessage(
			takerOrderParamsMessage
		);

		const swiftServerMessage: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig,
		};

		const encodedSwiftServerMessage =
			takerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = takerDriftClient.signMessage(
			Uint8Array.from(encodedSwiftServerMessage),
			swiftKeypair
		);

		let txSig;
		try {
			txSig = await makerDriftClient.placeAndMakeSwiftPerpOrder(
				encodedSwiftServerMessage,
				swiftSignature,
				takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
				takerOrderParamsSig,
				takerOrderParamsMessage.expectedOrderId,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				},
				makerOrderParams
			);
		} catch (error) {
			console.log(JSON.stringify(error));
		}

		printTxLogs(provider.connection, txSig);

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition === undefined);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition === undefined);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should fail on swift impersonator', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new TestClient({
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
		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
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

		await takerDriftClientUser.fetchAccounts();
		const takerOrderParamsMessage: SwiftOrderParamsMessage = {
			swiftOrderParams: takerOrderParams,
			expectedOrderId: 1,
			subAccountId: 0,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};
		const takerOrderParamsSig = takerDriftClient.signSwiftOrderParamsMessage(
			takerOrderParamsMessage
		);

		const swiftServerMessage: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig,
		};

		const encodedSwiftServerMessage =
			takerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = takerDriftClient.signMessage(
			Uint8Array.from(encodedSwiftServerMessage)
		);

		let txSig;
		try {
			txSig = await takerDriftClient.placeSwiftTakerOrder(
				encodedSwiftServerMessage,
				swiftSignature,
				takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
				takerOrderParamsSig,
				marketIndex,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				}
			);
		} catch (error) {
			console.log(JSON.stringify(error));
		}

		printTxLogs(provider.connection, txSig);

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition === undefined);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition === undefined);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});

	it('should fail if diff order passed to verify ix vs drift ix', async () => {
		// Taker number 1
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new TestClient({
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
		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
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

		await takerDriftClientUser.fetchAccounts();
		const takerOrderParamsMessage: SwiftOrderParamsMessage = {
			swiftOrderParams: takerOrderParams,
			expectedOrderId: 1,
			subAccountId: 0,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};
		const takerOrderParamsSig = takerDriftClient.signSwiftOrderParamsMessage(
			takerOrderParamsMessage
		);

		const swiftServerMessage: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig,
		};

		const encodedSwiftServerMessage =
			takerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = takerDriftClient.signMessage(
			Uint8Array.from(encodedSwiftServerMessage)
		);

		const ixsSet1 = await takerDriftClient.getPlaceSwiftTakerPerpOrderIxs(
			encodedSwiftServerMessage,
			swiftSignature,
			takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
			takerOrderParamsSig,
			marketIndex,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		// Taker number 2
		const keypair2 = new Keypair();
		await provider.connection.requestAirdrop(keypair2.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet2 = new Wallet(keypair);
		const userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair2.publicKey
		);
		const takerDriftClient2 = new TestClient({
			connection,
			wallet: wallet2,
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
		await takerDriftClient2.subscribe();
		await takerDriftClient2.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);
		const takerDriftClientUser2 = new User({
			driftClient: takerDriftClient2,
			userAccountPublicKey: await takerDriftClient2.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser2.subscribe();

		const takerOrderParamsSig2 = takerDriftClient2.signSwiftOrderParamsMessage(
			takerOrderParamsMessage
		);

		const swiftServerMessage2: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig2,
		};

		const encodedSwiftServerMessage2 =
			takerDriftClient2.encodeSwiftServerMessage(swiftServerMessage2);

		const swiftSignature2 = takerDriftClient.signMessage(
			Uint8Array.from(encodedSwiftServerMessage2)
		);

		const ixsSet2 = await takerDriftClient2.getPlaceSwiftTakerPerpOrderIxs(
			encodedSwiftServerMessage2,
			swiftSignature2,
			takerDriftClient2.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
			takerOrderParamsSig2,
			marketIndex,
			{
				taker: await takerDriftClient2.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient2.getUserAccount(),
				takerStats: takerDriftClient2.getUserStatsAccountPublicKey(),
			}
		);

		const tx = new Transaction();
		tx.add(...[ixsSet1[0], ixsSet1[1], ixsSet2[0]]);

		let txSig;
		try {
			txSig = await takerDriftClient.sendTransaction(tx);
		} catch (error) {
			console.log(JSON.stringify(error));
		}

		printTxLogs(provider.connection, txSig);

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition === undefined);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition === undefined);

		const takerPosition2 = takerDriftClient2.getUser().getPerpPosition(0);
		assert(takerPosition2 === undefined);

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
		await takerDriftClient2.unsubscribe();
		await takerDriftClientUser2.unsubscribe();
	});
});
