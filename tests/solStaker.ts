import * as anchor from '@coral-xyz/anchor';
// import { assert } from 'chai';
import {
	BN,
	OracleSource,
	TestClient,
	EventSubscriber,
	PRICE_PRECISION,
	PositionDirection,
	Wallet,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';
import {
	LAMPORTS_PER_SOL,
	StakeProgram,
	Authorized,
	sendAndConfirmTransaction,
	Lockup,
} from '@solana/web3.js';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
} from './testHelpers';
import {
	BulkAccountLoader,
} from '../sdk';

describe('stake to solana validator', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;

	const traderKeyPair = new Keypair();
	let traderUSDCAccount: Keypair;
	let traderDriftClient: TestClient;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let oracle: PublicKey;
	let solUsd: PublicKey;

	const numMkts = 8;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		oracle = await mockOracle(1);
		solUsd = await mockOracle(145.821);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
				{
					publicKey: solUsd,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solUsd);

		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		for (let i = 0; i < numMkts; i++) {
			await driftClient.initializePerpMarket(
				i,
				oracle,
				ammInitialBaseAssetReserve,
				ammInitialQuoteAssetReserve,
				periodicity
			);
		}

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		provider.connection.requestAirdrop(traderKeyPair.publicKey, 10 ** 9);
		traderUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			traderKeyPair.publicKey
		);
		traderDriftClient = new TestClient({
			connection,
			wallet: new Wallet(traderKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1, 2, 3, 4, 5, 6, 7],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
				{
					publicKey: solUsd,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await traderDriftClient.subscribe();

		await traderDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			traderUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await traderDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('stake', async () => {
		// Get all validators, categorized by current (i.e. active) and deliquent (i.e. inactive)
		const { current, delinquent } = await connection.getVoteAccounts();
		console.log('current validators: ', current);
		console.log('all validators: ', current.concat(delinquent));

		const wallet = Keypair.generate();
		const stakeAccount = Keypair.generate();

		// Calculate how much we want to stake
		const minimumRent = await connection.getMinimumBalanceForRentExemption(
			StakeProgram.space
		);
		const amountUserWantsToStake = LAMPORTS_PER_SOL / 2; // This is can be user input. For now, we'll hardcode to 0.5 SOL
		const amountToStake = minimumRent + amountUserWantsToStake;

		const createStakeAccountTx = StakeProgram.createAccount({
			authorized: new Authorized(wallet.publicKey, wallet.publicKey), // Here we set two authorities: Stake Authority and Withdrawal Authority. Both are set to our wallet.
			fromPubkey: wallet.publicKey,
			lamports: amountToStake,
			lockup: new Lockup(0, 0, wallet.publicKey), // Optional. We'll set this to 0 for demonstration purposes.
			stakePubkey: stakeAccount.publicKey,
		});

		const createStakeAccountTxId = await sendAndConfirmTransaction(
			connection,
			createStakeAccountTx,
			[
				wallet,
				stakeAccount, // Since we're creating a new stake account, we have that account sign as well
			]
		);
		console.log(`Stake account created. Tx Id: ${createStakeAccountTxId}`);

		// const txSig = await traderDriftClient.

		// await printTxLogs(connection, txSig);

		// const cus = (
		// 	await findComputeUnitConsumption(
		// 		driftClient.program.programId,
		// 		driftClient.connection,
		// 		txSig
		// 	)
		// )[0];
		// console.log(cus);
		// assert(cus < 380000);
	});
});
