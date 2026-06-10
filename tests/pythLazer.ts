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
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;

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
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH_LAZER },
		];

		velocityClient = new TestClient({
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

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
	});

	after(async () => {
		await velocityClient.unsubscribe();
	});

	// TODO: update BTC string for theses
	it('init feed', async () => {
		await velocityClient.initializePythLazerOracle(1);
		await velocityClient.initializePythLazerOracle(2);
		await velocityClient.initializePythLazerOracle(6);
	});

	it('crank', async () => {
		const ixs = await velocityClient.getPostPythLazerOracleUpdateIxs(
			[1],
			PYTH_LAZER_HEX_STRING_BTC,
			[]
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: velocityClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err === null);

		const normalTx = new Transaction();
		normalTx.add(...ixs);
		await velocityClient.sendTransaction(normalTx);
	});

	it('crank multi', async () => {
		const ixs = await velocityClient.getPostPythLazerOracleUpdateIxs(
			[1, 2, 6],
			PYTH_LAZER_HEX_STRING_MULTI
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: velocityClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err === null);
	});

	it('fails on wrong message passed', async () => {
		const ixs = await velocityClient.getPostPythLazerOracleUpdateIxs(
			[1],
			PYTH_LAZER_HEX_STRING_SOL
		);

		const message = new TransactionMessage({
			instructions: ixs,
			payerKey: velocityClient.wallet.payer.publicKey,
			recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		const simResult = await provider.connection.simulateTransaction(tx);
		console.log(simResult.value.logs);
		assert(simResult.value.err !== null);
	});
});
