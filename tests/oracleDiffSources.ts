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
	PRICE_PRECISION,
	Wallet,
	DriftClient,
	PEG_PRECISION,
} from '../sdk/src';

import {
	createFundedKeyPair,
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
// import { PRICE_PRECISION, PEG_PRECISION, Wallet, DriftClient } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('oracle diff sources', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, bankrunContextWrapper);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 3);

		marketIndexes = [0, 1];
		spotMarketIndexes = [0, 1, 2];
		oracleInfos = [
			{ publicKey: solOracle, source: OracleSource.PYTH },
			{ publicKey: solOracle, source: OracleSource.PYTH_1K },
		];

		admin = new TestClient({
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

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();
		await initializeQuoteSpotMarket(admin, usdcMint.publicKey);

		await initializeSolSpotMarket(
			admin,
			solOracle,
			undefined,
			OracleSource.PYTH
		);

		await initializeSolSpotMarket(
			admin,
			solOracle,
			undefined,
			OracleSource.PYTH_1K
		);

		const periodicity = new BN(0);
		await admin.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(3 * PEG_PRECISION.toNumber()),
			OracleSource.PYTH
		);

		await admin.initializePerpMarket(
			1,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(3000 * PEG_PRECISION.toNumber()),
			OracleSource.PYTH_1K
		);
	});

	beforeEach(async () => {
		// await admin.updateSpotMarketOracle(1, solOracle, OracleSource.PYTH);
		// await admin.updatePerpMarketOracle(0, solOracle, OracleSource.PYTH);
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('polling', async () => {
		const [driftClient, _usdcAccount, _userKeyPair] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		assert(driftClient.getSpotMarketAccount(1).oracle.equals(solOracle));
		assert(driftClient.getSpotMarketAccount(2).oracle.equals(solOracle));

		const normalPrice = await driftClient.getOracleDataForSpotMarket(1);
		assert(normalPrice.price.eq(PRICE_PRECISION.muln(3)));

		const oneKPrice = await driftClient.getOracleDataForSpotMarket(2);
		assert(oneKPrice.price.eq(PRICE_PRECISION.muln(3000)));

		assert(driftClient.getPerpMarketAccount(0).amm.oracle.equals(solOracle));
		assert(driftClient.getPerpMarketAccount(1).amm.oracle.equals(solOracle));

		const normalPerpPrice = await driftClient.getOracleDataForPerpMarket(0);
		assert(normalPerpPrice.price.eq(PRICE_PRECISION.muln(3)));

		const oneKPerpPrice = await driftClient.getOracleDataForPerpMarket(1);
		assert(oneKPerpPrice.price.eq(PRICE_PRECISION.muln(3000)));

		await driftClient.unsubscribe();
	});

	it('ws', async () => {
		const userKeyPair = await createFundedKeyPair(bankrunContextWrapper);
		const driftClient = new DriftClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(userKeyPair),
			programID: admin.program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'websocket',
			},
		});
		await driftClient.subscribe();

		const normalPrice = await driftClient.getOracleDataForSpotMarket(1);
		assert(normalPrice.price.eq(PRICE_PRECISION.muln(3)));

		const oneKPrice = await driftClient.getOracleDataForSpotMarket(2);
		assert(oneKPrice.price.eq(PRICE_PRECISION.muln(3000)));

		const normalPerpPrice = await driftClient.getOracleDataForPerpMarket(0);
		assert(normalPerpPrice.price.eq(PRICE_PRECISION.muln(3)));

		const oneKPerpPrice = await driftClient.getOracleDataForPerpMarket(1);
		assert(oneKPerpPrice.price.eq(PRICE_PRECISION.muln(3000)));

		await driftClient.unsubscribe();
	});
});
