import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BulkAccountLoader,
	OracleSource,
	PTYH_LAZER_PROGRAM_ID,
	TestClient,
	getPythLazerOraclePublicKey,
} from '../sdk/src';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
} from './testHelpersLocalValidator';
import { Wallet, loadKeypair } from '../sdk/src';
import { PYTH_LAZER_HEX_STRING_BTC, PYTH_STORAGE_DATA } from './pythLazerData';

// set up account infos to load into banks client
const PYTH_STORAGE_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: new PublicKey(PTYH_LAZER_PROGRAM_ID),
	rentEpoch: 0,
	data: Buffer.from(PYTH_STORAGE_DATA, 'base64'),
};

describe('pyth lazer oracles', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 0);

	let usdcMint;
	const feedId = 3;
	let solUsd: PublicKey;

	before(async () => {
		// use bankrun builtin function to start solana program test

		await provider.connection.requestAirdrop(
			provider.wallet.publicKey,
			10 ** 9
		);
		usdcMint = await mockUSDCMint(provider);
		solUsd = getPythLazerOraclePublicKey(chProgram.programId, feedId);

		const marketIndexes = [0];
		const spotMarketIndexes = [0, 1];
		const oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		driftClient = new TestClient({
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
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('init feed', async () => {
		await driftClient.initializePythLazerOracle(1);
	});

	it('crank', async () => {
		const tx = await driftClient.postPythLazerOracleUpdate(
			1,
			PYTH_LAZER_HEX_STRING_BTC
		);
		console.log(tx);
	});
});
