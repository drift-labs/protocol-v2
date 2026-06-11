import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	getMarketOrderParams,
	OracleSource,
	Wallet,
	MarketStatus,
	TestClient,
	PositionDirection,
} from '../sdk/src';

import { Program } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('round in favor', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;

	let primaryVelocityClient: TestClient;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);
	const ammInitialBaseAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);

	const usdcAmount = new BN(9999 * 10 ** 3);

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

		const solUsd = await mockOracleNoProgram(
			bankrunContextWrapper,
			63000,
			-7,
			undefined,
			10000
		);

		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }];

		primaryVelocityClient = new TestClient({
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
		await primaryVelocityClient.initialize(usdcMint.publicKey, true);
		await primaryVelocityClient.subscribe();

		await initializeQuoteSpotMarket(primaryVelocityClient, usdcMint.publicKey);
		await primaryVelocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryVelocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000000)
		);
		await primaryVelocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
	});

	after(async () => {
		await primaryVelocityClient.unsubscribe();
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
		await velocityClient.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = new BN(789640);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await velocityClient.placeAndTakePerpOrder(orderParams);

		assert(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await velocityClient.fetchAccounts();
		await velocityClient.closePosition(marketIndex);

		await velocityClient.fetchAccounts();

		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-88262))
		);
		await velocityClient.unsubscribe();
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
		await velocityClient.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = new BN(789566);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await velocityClient.placeAndTakePerpOrder(orderParams);

		assert(velocityClient.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await velocityClient.closePosition(marketIndex);
		await velocityClient.fetchAccounts();

		console.log(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			velocityClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-88268))
		);
		await velocityClient.unsubscribe();
	});
});
