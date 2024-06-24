import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	MarketStatus,
	OracleSource,
	TestClient,
} from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { DEFAULT_RECEIVER_PROGRAM_ID } from '@pythnetwork/pyth-solana-receiver';
import {
	PYTH_ORACLE_ONE_DATA,
	PYTH_ORACLE_TWO_DATA,
} from './pythPullOracleData';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';
import { assert } from 'chai';

// set up account infos to load into banks client
const PYTH_ORACLE_ONE: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: DEFAULT_RECEIVER_PROGRAM_ID,
	rentEpoch: 0,
	data: Buffer.from(PYTH_ORACLE_ONE_DATA, 'base64'),
};

const PYTH_ORACLE_TWO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: DEFAULT_RECEIVER_PROGRAM_ID,
	rentEpoch: 0,
	data: Buffer.from(PYTH_ORACLE_TWO_DATA, 'base64'),
};

describe('pyth pull oracles', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;

	const ammInitialQuoteAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);
	const ammInitialBaseAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);

	// random pubkeys (accessible everywhere) for arbitrary accounts
	const oracleOnePubkey = PublicKey.unique();
	const oracleTwoPubkey = PublicKey.unique();

	before(async () => {
		// use bankrun builtin function to start solana program test
		const context = await startAnchor(
			'',
			[],
			[
				// load account infos into banks client like this
				{
					address: oracleOnePubkey,
					info: PYTH_ORACLE_ONE,
				},
				{
					address: oracleTwoPubkey,
					info: PYTH_ORACLE_TWO,
				},
			]
		);

		// wrap the context to use it with the test helpers
		bankrunContextWrapper = new BankrunContextWrapper(context);

		// don't use regular bulk account loader, use test
		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		driftClient = new TestClient({
			// call toConnection to avoid annoying type error
			connection: bankrunContextWrapper.connection.toConnection(),
			// make sure to avoid regular `provider.X`, they don't show as errors
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: [0],
			subAccountIds: [], // make sure to add [] for subaccounts or client will gpa
			oracleInfos: [
				{
					publicKey: oracleOnePubkey,
					source: OracleSource.PYTH_PULL,
				},
				{
					publicKey: oracleTwoPubkey,
					source: OracleSource.PYTH_PULL,
				},
			],
			// BANKRUN DOES NOT WORK WITH WEBSOCKET
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			oracleOnePubkey,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000000),
			OracleSource.PYTH_PULL
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await driftClient.initializePerpMarket(
			1,
			oracleTwoPubkey,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000000),
			OracleSource.PYTH_PULL
		);
		await driftClient.updatePerpMarketStatus(1, MarketStatus.ACTIVE);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('parses prices', async () => {
		const priceDataOne = driftClient.getOracleDataForPerpMarket(0);
		const priceDataTwo = driftClient.getOracleDataForPerpMarket(1);

		assert(
			priceDataOne.price.eq(new BN(148563151)),
			`priceDataOne.price: ${priceDataOne.price.toString()}`
		);
		assert(
			priceDataOne.slot.eq(new BN(271269395)),
			`priceDataOne.slot: ${priceDataOne.slot.toString()}`
		);

		assert(
			priceDataTwo.price.eq(new BN(134677319)),
			`priceDataTwo.price: ${priceDataTwo.price.toString()}`
		);
		assert(
			priceDataTwo.slot.eq(new BN(272607101)),
			`priceDataTwo.slot: ${priceDataTwo.slot.toString()}`
		);
	});
});
