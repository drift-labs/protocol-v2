import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BN,
	OracleSource,
	PEG_PRECISION,
	PRICE_PRECISION,
	PTYH_LAZER_PROGRAM_ID,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
	TestClient,
	assert,
	getPythLazerOraclePublicKey,
	isVariant,
} from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/bulkAccountLoader/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';
import {
	PYTH_LAZER_HEX_STRING_MULTI,
	PYTH_LAZER_HEX_STRING_SOL,
	PYTH_STORAGE_DATA,
} from './pythLazerData';
import { mockOracleNoProgram } from './testHelpers';

// set up account infos to load into banks client
const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('pyth pull oracles', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;

	const feedId = 0;

	let feedAddress: PublicKey;

	before(async () => {
		// use bankrun builtin function to start solana program test
		const context = await startAnchor(
			'',
			[],
			[
				{
					address: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
					info: PYTH_STORAGE_ACCOUNT_INFO,
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
		feedAddress = getPythLazerOraclePublicKey(chProgram.programId, feedId);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: feedAddress,
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
		const ammInitialQuoteAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetReserve = new anchor.BN(10 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const periodicity = new BN(0);
		await driftClient.initializePerpMarket(
			0,
			await mockOracleNoProgram(bankrunContextWrapper, 224.3),
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(224 * PEG_PRECISION.toNumber())
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('init feed', async () => {
		await driftClient.initializePythLazerOracle(1);
		await driftClient.initializePythLazerOracle(2);
		await driftClient.initializePythLazerOracle(6);
	});

	it('crank single', async () => {
		await driftClient.postPythLazerOracleUpdate([6], PYTH_LAZER_HEX_STRING_SOL);
		await driftClient.updatePerpMarketOracle(
			0,
			getPythLazerOraclePublicKey(driftClient.program.programId, 6),
			OracleSource.PYTH_LAZER
		);
		await driftClient.fetchAccounts();
		assert(
			isVariant(
				driftClient.getPerpMarketAccount(0).amm.oracleSource,
				'pythLazer'
			)
		);
	});

	it('crank multi', async () => {
		const tx = await driftClient.postPythLazerOracleUpdate(
			[1, 2, 6],
			PYTH_LAZER_HEX_STRING_MULTI
		);
		console.log(tx);
	});
});
