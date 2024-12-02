import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	ComputeBudgetProgram,
	Keypair,
	PublicKey,
	SendTransactionError,
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
	DriftClient,
	ANCHOR_TEST_SWIFT_ID,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpersLocalValidator';
import { PEG_PRECISION, PostOnlyParams } from '../sdk/src';
import dotenv from 'dotenv';
import { digest } from '../sdk/src/util/digest';
import { nanoid } from 'nanoid';
dotenv.config();

describe('place and make swift order', () => {
	if (!process.env.SWIFT_PRIVATE_KEY) {
		throw new Error('SWIFT_PRIVATE_KEY not set');
	}

	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET not set');
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

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 0);

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
		const makerWallet = new Wallet(loadKeypair(process.env.ANCHOR_WALLET));
		await provider.connection.requestAirdrop(
			provider.wallet.publicKey,
			10 ** 9
		);
		await provider.connection.requestAirdrop(makerWallet.publicKey, 10 ** 9);

		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(32.821);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		makerDriftClient = new TestClient({
			connection,
			//@ts-ignore
			wallet: new Wallet(loadKeypair(process.env.ANCHOR_WALLET)),
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
		await takerDriftClient.initializeSwiftUserOrders(
			takerDriftClientUser.userAccountPublicKey,
			32
		);

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
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};

		const encodedSwiftServerMessage =
			makerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = makerDriftClient.signMessage(
			digest(encodedSwiftServerMessage),
			swiftKeypair
		);

		let ixs = await makerDriftClient.getPlaceAndMakeSwiftPerpOrderIxs(
			encodedSwiftServerMessage,
			swiftSignature,
			takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
			takerOrderParamsSig,
			swiftServerMessage.uuid,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			},
			makerOrderParams
		);
		ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 10_000_000,
			}),
			...ixs,
		];

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: makerDriftClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err === null);

		const normalTx = new Transaction();
		normalTx.add(...ixs);
		await makerDriftClient.sendTransaction(normalTx);
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
		await takerDriftClient.initializeSwiftUserOrders(
			takerDriftClientUser.userAccountPublicKey,
			32
		);

		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getMarketOrderParams({
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
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};

		const encodedSwiftServerMessage =
			makerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = makerDriftClient.signMessage(
			digest(encodedSwiftServerMessage),
			swiftKeypair
		);

		try {
			let ixs = await makerDriftClient.getPlaceAndMakeSwiftPerpOrderIxs(
				encodedSwiftServerMessage,
				swiftSignature,
				takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
				takerOrderParamsSig,
				swiftServerMessage.uuid,
				{
					taker: await takerDriftClient.getUserAccountPublicKey(),
					takerUserAccount: takerDriftClient.getUserAccount(),
					takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
				},
				makerOrderParams
			);
			ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 10_000_000,
				}),
				...ixs,
			];
			await makerDriftClient.sendTransaction(new Transaction().add(...ixs));
			assert.fail('Should have failed');
		} catch (error) {
			assert.equal(
				error.transactionMessage,
				'Transaction precompile verification failure InvalidAccountIndex'
			);
		}
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
		await takerDriftClient.initializeSwiftUserOrders(
			takerDriftClientUser.userAccountPublicKey,
			32
		);

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

		// Auth part begins
		const takerOrderParamsMessage: SwiftOrderParamsMessage = {
			swiftOrderParams: takerOrderParams,
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
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};

		const encodedSwiftServerMessage =
			takerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = takerDriftClient.signMessage(
			digest(encodedSwiftServerMessage)
		);

		try {
			let ixs = await makerDriftClient.getPlaceSwiftTakerPerpOrderIxs(
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
			ixs = [
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 10_000_000,
				}),
				...ixs,
			];
			await makerDriftClient.sendTransaction(new Transaction().add(...ixs));
			assert.fail('Should have failed');
		} catch (error) {
			assert.equal(
				error.transactionMessage,
				'Transaction precompile verification failure InvalidAccountIndex'
			);
		}
	});

	it('should fail if diff signed message to verify ixs vs drift ixs', async () => {
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
		await takerDriftClient.initializeSwiftUserOrders(
			takerDriftClientUser.userAccountPublicKey,
			32
		);

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
			subAccountId: 0,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		await takerDriftClientUser.fetchAccounts();

		// Auth for legit order
		const takerOrderParamsSig = takerDriftClient.signSwiftOrderParamsMessage(
			takerOrderParamsMessage
		);

		const swiftServerMessage: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};

		const encodedSwiftServerMessage =
			makerDriftClient.encodeSwiftServerMessage(swiftServerMessage);

		const swiftSignature = makerDriftClient.signMessage(
			digest(encodedSwiftServerMessage),
			swiftKeypair
		);

		// Auth for non-legit order
		const takerOrderParamsMessage2: SwiftOrderParamsMessage = {
			swiftOrderParams: Object.assign({}, takerOrderParams, {
				direction: PositionDirection.SHORT,
				auctionStartPrice: new BN(34).mul(PRICE_PRECISION),
				auctionEndPrice: new BN(33).mul(PRICE_PRECISION),
				price: new BN(33).mul(PRICE_PRECISION),
			}),
			subAccountId: 0,
			takeProfitOrderParams: null,
			stopLossOrderParams: null,
		};

		const takerOrderParamsSig2 = takerDriftClient.signSwiftOrderParamsMessage(
			takerOrderParamsMessage2
		);

		const swiftServerMessage2: SwiftServerMessage = {
			slot: new BN(await connection.getSlot()),
			swiftOrderSignature: takerOrderParamsSig2,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};

		const encodedSwiftServerMessage2 =
			makerDriftClient.encodeSwiftServerMessage(swiftServerMessage2);

		const swiftSignature2 = makerDriftClient.signMessage(
			digest(encodedSwiftServerMessage2),
			swiftKeypair
		);

		const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
			units: 10_000_000,
		});

		const ixs = await makerDriftClient.getPlaceSwiftTakerPerpOrderIxs(
			encodedSwiftServerMessage,
			swiftSignature,
			takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage),
			takerOrderParamsSig,
			0,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		const ixsForOrder2 = await makerDriftClient.getPlaceSwiftTakerPerpOrderIxs(
			encodedSwiftServerMessage2,
			swiftSignature2,
			takerDriftClient.encodeSwiftOrderParamsMessage(takerOrderParamsMessage2),
			takerOrderParamsSig2,
			0,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		const badOrderTx = new Transaction();
		badOrderTx.add(
			...[computeBudgetIx, ixs[0], ixsForOrder2[1], ixsForOrder2[2]]
		);
		try {
			await makerDriftClient.sendTransaction(badOrderTx);
			assert.fail('Should have failed');
		} catch (error) {
			console.log((error as SendTransactionError).logs);
			assert(
				(error as SendTransactionError).logs.some((log) =>
					log.includes('SigVerificationFailed')
				)
			);
		}

		const badSwiftTx = new Transaction();
		badSwiftTx.add(
			...[computeBudgetIx, ixsForOrder2[0], ixs[1], ixsForOrder2[2]]
		);
		try {
			await makerDriftClient.sendTransaction(badSwiftTx);
			assert.fail('Should have failed');
		} catch (error) {
			console.log((error as SendTransactionError).logs);
			assert(
				(error as SendTransactionError).logs.some((log) =>
					log.includes('SigVerificationFailed')
				)
			);
		}
	});
});
