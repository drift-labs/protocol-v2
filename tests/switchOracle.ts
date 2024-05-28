import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	EventSubscriber,
	OracleSource,
	OracleInfo,
} from '../sdk/src';

import {
	createFundedKeyPair,
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import {
	BulkAccountLoader,
	PRICE_PRECISION,
	PEG_PRECISION,
	Wallet,
	DriftClient,
} from '../sdk';

describe('switch oracles', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let solOracle: PublicKey;

	let usdcMint;

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, provider);

		solOracle = await mockOracle(30);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new TestClient({
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

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();
		await initializeQuoteSpotMarket(admin, usdcMint.publicKey);

		await initializeSolSpotMarket(admin, solOracle);

		const periodicity = new BN(0);
		await admin.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(30 * PEG_PRECISION.toNumber())
		);
	});

	beforeEach(async () => {
		await admin.updateSpotMarketOracle(1, solOracle, OracleSource.PYTH);
		await admin.updatePerpMarketOracle(0, solOracle, OracleSource.PYTH);
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('polling', async () => {
		const [driftClient, _usdcAccount, _userKeyPair] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		const newSolOracle = await mockOracle(100);

		await admin.updatePerpMarketOracle(0, newSolOracle, OracleSource.PYTH);

		await admin.fetchAccounts();
		const perpOraclePriceBefore = await driftClient.getOracleDataForPerpMarket(
			0
		);
		assert(perpOraclePriceBefore.price.eq(PRICE_PRECISION.muln(30)));

		await sleep(1000);

		const perpOraclePriceAfter = await driftClient.getOracleDataForPerpMarket(
			0
		);
		assert(perpOraclePriceAfter.price.eq(PRICE_PRECISION.muln(100)));

		await admin.updateSpotMarketOracle(1, newSolOracle, OracleSource.PYTH);

		await driftClient.fetchAccounts();
		const spotOraclePriceBefore = await driftClient.getOracleDataForSpotMarket(
			1
		);
		assert(spotOraclePriceBefore.price.eq(PRICE_PRECISION.muln(30)));

		await sleep(1000);

		const spotOraclePriceAfter = await driftClient.getOracleDataForSpotMarket(
			1
		);
		console.log(spotOraclePriceAfter.price.toString());
		assert(spotOraclePriceAfter.price.eq(PRICE_PRECISION.muln(100)));

		await driftClient.unsubscribe();
	});

	it('ws', async () => {
		const userKeyPair = await createFundedKeyPair(provider.connection);
		const driftClient = new DriftClient({
			connection,
			wallet: new Wallet(userKeyPair),
			programID: admin.program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			accountSubscription: {
				type: 'websocket',
			},
		});
		await driftClient.subscribe();

		const newSolOracle = await mockOracle(100);

		await admin.updatePerpMarketOracle(0, newSolOracle, OracleSource.PYTH);

		const perpOraclePriceBefore = await driftClient.getOracleDataForPerpMarket(
			0
		);
		console.log('oraclePriceBefore', perpOraclePriceBefore.price.toNumber());
		assert(perpOraclePriceBefore.price.eq(PRICE_PRECISION.muln(30)));

		await sleep(5000);

		const perpOraclePriceAfter = await driftClient.getOracleDataForPerpMarket(
			0
		);
		assert(perpOraclePriceAfter.price.eq(PRICE_PRECISION.muln(100)));

		await admin.updateSpotMarketOracle(1, newSolOracle, OracleSource.PYTH);

		const spotOraclePriceBefore = await driftClient.getOracleDataForSpotMarket(
			1
		);
		assert(spotOraclePriceBefore.price.eq(PRICE_PRECISION.muln(30)));

		await sleep(1000);

		const spotOraclePriceAfter = await driftClient.getOracleDataForSpotMarket(
			1
		);
		assert(spotOraclePriceAfter.price.eq(PRICE_PRECISION.muln(100)));

		await driftClient.unsubscribe();
	});
});
