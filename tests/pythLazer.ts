import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	BulkAccountLoader,
	OracleSource,
	TestClient,
	assert,
	getPythLazerOraclePublicKey,
} from '../sdk/src';
import {
	PublicKey,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
} from './testHelpersLocalValidator';
import { Wallet, loadKeypair, EventSubscriber } from '../sdk/src';
import {
	PYTH_LAZER_HEX_STRING_BTC,
	PYTH_LAZER_HEX_STRING_MULTI,
	PYTH_LAZER_HEX_STRING_SOL,
} from './pythLazerData';

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

	//@ts-ignore
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

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
		await driftClient.initializePythLazerOracle(2);
		await driftClient.initializePythLazerOracle(6);
	});

	it('crank', async () => {
		const ixs = await driftClient.getPostPythLazerOracleUpdateIxs(
			[1],
			PYTH_LAZER_HEX_STRING_BTC,
			[]
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: driftClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err === null);

		const normalTx = new Transaction();
		normalTx.add(...ixs);
		await driftClient.sendTransaction(normalTx);
	});

	it('crank multi', async () => {
		const ixs = await driftClient.getPostPythLazerOracleUpdateIxs(
			[1, 2, 6],
			PYTH_LAZER_HEX_STRING_MULTI
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: driftClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err === null);
	});

	it('fails on wrong message passed', async () => {
		const ixs = await driftClient.getPostPythLazerOracleUpdateIxs(
			[1],
			PYTH_LAZER_HEX_STRING_SOL
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: driftClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err !== null);
	});
});
