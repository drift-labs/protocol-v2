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
	PEG_PRECISION,
	Wallet,
	VelocityClient,
} from '../sdk/src';

import {
	createFundedKeyPair,
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

async function waitForOraclePrice(
	getOraclePrice: () => { price: BN },
	expectedPrice: BN,
	timeoutMs = 10000
) {
	const start = Date.now();
	let lastPrice: BN | undefined;
	let lastError: Error | undefined;

	while (Date.now() - start < timeoutMs) {
		try {
			const oraclePrice = getOraclePrice();
			lastPrice = oraclePrice.price;
			if (lastPrice.eq(expectedPrice)) {
				return oraclePrice;
			}
		} catch (e) {
			lastError = e as Error;
		}

		await sleep(250);
	}

	assert(
		false,
		`Timed out waiting for oracle price ${expectedPrice.toString()}. Last price: ${
			lastPrice?.toString() ?? 'none'
		}. Last error: ${lastError?.message ?? 'none'}`
	);
}

describe('switch oracles', () => {
	const chProgram = anchor.workspace.Velocity as Program;

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

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 30);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH_LAZER }];

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
		await admin.initializeAmmCache();
	});

	beforeEach(async () => {
		await admin.updateSpotMarketOracle(
			1,
			solOracle,
			OracleSource.PYTH_LAZER,
			true
		);
		await admin.updatePerpMarketOracle(
			0,
			solOracle,
			OracleSource.PYTH_LAZER,
			true
		);
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('polling', async () => {
		const [velocityClient, _usdcAccount, _userKeyPair] =
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

		const newSolOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		await admin.updatePerpMarketOracle(
			0,
			newSolOracle,
			OracleSource.PYTH_LAZER,
			true
		);

		await admin.fetchAccounts();
		const perpOraclePriceBefore =
			await velocityClient.getOracleDataForPerpMarket(0);
		assert(perpOraclePriceBefore.price.eq(PRICE_PRECISION.muln(30)));

		await sleep(1000);

		const perpOraclePriceAfter =
			await velocityClient.getOracleDataForPerpMarket(0);
		assert(perpOraclePriceAfter.price.eq(PRICE_PRECISION.muln(100)));

		await admin.updateSpotMarketOracle(
			1,
			newSolOracle,
			OracleSource.PYTH_LAZER,
			true
		);

		await velocityClient.fetchAccounts();
		const spotOraclePriceBefore =
			await velocityClient.getOracleDataForSpotMarket(1);
		assert(spotOraclePriceBefore.price.eq(PRICE_PRECISION.muln(30)));

		await sleep(1000);

		const spotOraclePriceAfter =
			await velocityClient.getOracleDataForSpotMarket(1);
		console.log(spotOraclePriceAfter.price.toString());
		assert(spotOraclePriceAfter.price.eq(PRICE_PRECISION.muln(100)));

		await velocityClient.unsubscribe();
	});

	it('ws', async () => {
		const userKeyPair = await createFundedKeyPair(bankrunContextWrapper);
		const velocityClient = new VelocityClient({
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
		await velocityClient.subscribe();

		const newSolOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		await waitForOraclePrice(
			() => velocityClient.getOracleDataForPerpMarket(0),
			PRICE_PRECISION.muln(30)
		);

		await admin.updatePerpMarketOracle(
			0,
			newSolOracle,
			OracleSource.PYTH_LAZER,
			true
		);

		await waitForOraclePrice(
			() => velocityClient.getOracleDataForPerpMarket(0),
			PRICE_PRECISION.muln(100)
		);

		await waitForOraclePrice(
			() => velocityClient.getOracleDataForSpotMarket(1),
			PRICE_PRECISION.muln(30)
		);

		await admin.updateSpotMarketOracle(
			1,
			newSolOracle,
			OracleSource.PYTH_LAZER,
			true
		);

		await waitForOraclePrice(
			() => velocityClient.getOracleDataForSpotMarket(1),
			PRICE_PRECISION.muln(100)
		);

		await velocityClient.unsubscribe();
	});
});
