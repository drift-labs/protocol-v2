import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	User,
	Wallet,
	EventSubscriber,
	OracleSource,
	RFQMakerOrderParams,
	PositionDirection,
	MarketType,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { BASE_PRECISION, BN_MAX, PEG_PRECISION, ZERO } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { nanoid } from 'nanoid';

describe('place and fill rfq orders', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let takerDriftClient: TestClient;
	let takerDriftClientUser: User;

	let makerDriftClient: TestClient;
	let makerDriftClientUser: User;

	let makerDriftClient1: TestClient;
	let makerDriftClientUser1: User;

	let makerDriftClient2: TestClient;
	let makerDriftClientUser2: User;

	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 100);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		takerDriftClient = new TestClient({
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
		await takerDriftClient.initialize(usdcMint.publicKey, true);
		await takerDriftClient.subscribe();
		await initializeQuoteSpotMarket(takerDriftClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await takerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(100 * PEG_PRECISION.toNumber())
		);

		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await takerDriftClientUser.subscribe();

		// Create some makers
		let keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		await sleep(500);
		let wallet = new Wallet(keypair);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		makerDriftClient = new TestClient({
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
		await makerDriftClient.subscribe();
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

		// Create some makers
		keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		await sleep(500);
		wallet = new Wallet(keypair);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		makerDriftClient1 = new TestClient({
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
		await makerDriftClient1.subscribe();
		await makerDriftClient1.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		makerDriftClientUser1 = new User({
			driftClient: makerDriftClient1,
			userAccountPublicKey: await makerDriftClient1.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerDriftClientUser1.subscribe();

		// Create some makers
		keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		await sleep(500);
		wallet = new Wallet(keypair);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			keypair.publicKey
		);
		makerDriftClient2 = new TestClient({
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
		await makerDriftClient2.subscribe();
		await makerDriftClient2.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		makerDriftClientUser2 = new User({
			driftClient: makerDriftClient2,
			userAccountPublicKey: await makerDriftClient2.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerDriftClientUser2.subscribe();

		// Create the maker's rfq accounts
		let [txSig, _rfqUserAccountPublicKey] =
			await makerDriftClient.initializeRFQUser(
				makerDriftClientUser.userAccountPublicKey
			);

		bankrunContextWrapper.printTxLogs(txSig);

		[txSig, _rfqUserAccountPublicKey] =
			await makerDriftClient1.initializeRFQUser(
				makerDriftClientUser1.userAccountPublicKey
			);

		bankrunContextWrapper.printTxLogs(txSig);

		[txSig, _rfqUserAccountPublicKey] =
			await makerDriftClient2.initializeRFQUser(
				makerDriftClientUser2.userAccountPublicKey
			);

		bankrunContextWrapper.printTxLogs(txSig);
	});

	after(async () => {
		await makerDriftClientUser.unsubscribe();
		await makerDriftClientUser1.unsubscribe();
		await makerDriftClientUser2.unsubscribe();

		await makerDriftClient.unsubscribe();
		await makerDriftClient1.unsubscribe();
		await makerDriftClient2.unsubscribe();

		await takerDriftClient.unsubscribe();
		await takerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('should match rfq orders successfully', async () => {
		// Makers sign a messages to create a limit order

		const makerOrderMessage: RFQMakerOrderParams = {
			marketIndex: 0,
			marketType: MarketType.PERP,
			direction: PositionDirection.SHORT,
			authority: makerDriftClientUser.getUserAccount().authority,
			subAccountId: 0,
			price: new BN(100).mul(PRICE_PRECISION),
			baseAssetAmount: BASE_PRECISION,
			maxTs: BN_MAX,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};
		const signature = makerDriftClient.signMessage(
			makerDriftClient.encodeRFQMakerOrderParams(makerOrderMessage)
		);

		const _makerOrderMessage1: RFQMakerOrderParams = {
			marketIndex: 0,
			marketType: MarketType.PERP,
			direction: PositionDirection.SHORT,
			authority: makerDriftClientUser1.getUserAccount().authority,
			subAccountId: 0,
			price: new BN(100).mul(PRICE_PRECISION),
			baseAssetAmount: BASE_PRECISION,
			maxTs: BN_MAX,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};
		const _signature1 = makerDriftClient1.signMessage(
			makerDriftClient1.encodeRFQMakerOrderParams(makerOrderMessage)
		);

		await takerDriftClient.placeAndMatchRFQOrders([
			{
				baseAssetAmount: BASE_PRECISION,
				makerOrderParams: makerOrderMessage,
				makerSignature: signature,
			},
			// would fail if we included the second order as well bc tx too large
			// {
			// 	baseAssetAmount: BASE_PRECISION,
			// 	makerOrderParams: _makerOrderMessage1,
			// 	makerSignature: _signature1,
			// },
		]);

		assert(
			makerDriftClientUser
				.getPerpPosition(0)
				.baseAssetAmount.eq(BASE_PRECISION.neg())
		);
		assert(
			takerDriftClientUser.getPerpPosition(0).baseAssetAmount.eq(BASE_PRECISION)
		);
	});

	it('should not match again if order was already used once', async () => {
		// Makers sign a messages to create a limit order

		const makerOrderMessage: RFQMakerOrderParams = {
			marketIndex: 0,
			marketType: MarketType.PERP,
			direction: PositionDirection.SHORT,
			authority: makerDriftClientUser.getUserAccount().authority,
			subAccountId: 0,
			price: new BN(100).mul(PRICE_PRECISION),
			baseAssetAmount: BASE_PRECISION,
			maxTs: BN_MAX,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};
		const signature = makerDriftClient.signMessage(
			makerDriftClient.encodeRFQMakerOrderParams(makerOrderMessage)
		);

		await takerDriftClient.placeAndMatchRFQOrders([
			{
				baseAssetAmount: BASE_PRECISION,
				makerOrderParams: makerOrderMessage,
				makerSignature: signature,
			},
		]);

		const makerPositionBefore = makerDriftClientUser.getPerpPosition(0);
		const takerPositionBefore = takerDriftClientUser.getPerpPosition(0);

		await takerDriftClient.placeAndMatchRFQOrders([
			{
				baseAssetAmount: BASE_PRECISION,
				makerOrderParams: makerOrderMessage,
				makerSignature: signature,
			},
		]);

		const makerPositionAfter = makerDriftClientUser.getPerpPosition(0);
		const takerPositionAfter = takerDriftClientUser.getPerpPosition(0);

		assert(
			makerPositionBefore.baseAssetAmount.eq(makerPositionAfter.baseAssetAmount)
		);
		assert(
			takerPositionBefore.baseAssetAmount.eq(takerPositionAfter.baseAssetAmount)
		);
	});

	it('should not match if maker order is expired', async () => {
		// Makers sign a messages to create a limit order

		const makerOrderMessage: RFQMakerOrderParams = {
			marketIndex: 0,
			marketType: MarketType.PERP,
			direction: PositionDirection.SHORT,
			authority: makerDriftClientUser.getUserAccount().authority,
			subAccountId: 0,
			price: new BN(100).mul(PRICE_PRECISION),
			baseAssetAmount: BASE_PRECISION,
			maxTs: ZERO,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};
		const signature = makerDriftClient.signMessage(
			makerDriftClient.encodeRFQMakerOrderParams(makerOrderMessage)
		);

		const makerPositionBefore = makerDriftClientUser.getPerpPosition(0);
		const takerPositionBefore = takerDriftClientUser.getPerpPosition(0);

		await takerDriftClient.placeAndMatchRFQOrders([
			{
				baseAssetAmount: BASE_PRECISION,
				makerOrderParams: makerOrderMessage,
				makerSignature: signature,
			},
		]);

		const makerPositionAfter = makerDriftClientUser.getPerpPosition(0);
		const takerPositionAfter = takerDriftClientUser.getPerpPosition(0);

		assert(
			makerPositionBefore.baseAssetAmount.eq(makerPositionAfter.baseAssetAmount)
		);
		assert(
			takerPositionBefore.baseAssetAmount.eq(takerPositionAfter.baseAssetAmount)
		);
		assert(makerDriftClientUser.getOpenOrders().length === 0);
	});

	it('should not match if rfq match exceeds maker base asset amount', async () => {
		// Makers sign a messages to create a limit order

		const makerOrderMessage: RFQMakerOrderParams = {
			marketIndex: 0,
			marketType: MarketType.PERP,
			direction: PositionDirection.SHORT,
			authority: makerDriftClientUser.getUserAccount().authority,
			subAccountId: 0,
			price: new BN(100).mul(PRICE_PRECISION),
			baseAssetAmount: BASE_PRECISION,
			maxTs: ZERO,
			uuid: Uint8Array.from(Buffer.from(nanoid(8))),
		};
		const signature = makerDriftClient.signMessage(
			makerDriftClient.encodeRFQMakerOrderParams(makerOrderMessage)
		);

		const makerPositionBefore = makerDriftClientUser.getPerpPosition(0);
		const takerPositionBefore = takerDriftClientUser.getPerpPosition(0);

		// expect error
		try {
			await takerDriftClient.placeAndMatchRFQOrders([
				{
					baseAssetAmount: BASE_PRECISION.muln(2),
					makerOrderParams: makerOrderMessage,
					makerSignature: signature,
				},
			]);
		} catch (e) {
			console.log(e);
		}

		const makerPositionAfter = makerDriftClientUser.getPerpPosition(0);
		const takerPositionAfter = takerDriftClientUser.getPerpPosition(0);

		assert(
			makerPositionBefore.baseAssetAmount.eq(makerPositionAfter.baseAssetAmount)
		);
		assert(
			takerPositionBefore.baseAssetAmount.eq(takerPositionAfter.baseAssetAmount)
		);
		assert(makerDriftClientUser.getOpenOrders().length === 0);
	});
});
