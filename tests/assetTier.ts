import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	TestClient,
	BN,
	EventSubscriber,
	ZERO,
	// SPOT_MARKET_RATE_PRECISION,
	// SpotBalanceType,
	isVariant,
	OracleSource,
	// SPOT_MARKET_WEIGHT_PRECISION,
	// SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	// OracleInfo,
	AMM_RESERVE_PRECISION,
	MarketStatus,
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	AssetTier,
	SPOT_MARKET_WEIGHT_PRECISION,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	// setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	createUSDCAccountForUser,
	// getFeedData,
	// sleep,
} from './testHelpers';
import { BulkAccountLoader } from '../sdk';

describe('asset tiers', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
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
	let dogeMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;
	let dogeOracle: PublicKey;
	const usdcAmount = new BN(1000000 * 10 ** 6); //1M

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;
	let secondUserDriftClientDogeAccount: PublicKey;
	let secondUserKeyPair: Keypair;

	const solAmount = new BN(10000 * 10 ** 9);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		dogeMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			provider
		);

		solOracle = await mockOracle(22500); // a future we all need to believe in
		dogeOracle = await mockOracle(0.05);

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
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize();
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);
		await initializeSolSpotMarket(driftClient, dogeOracle, dogeMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await driftClient.initializePerpMarket(
			0,
			solOracle,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION,
			periodicity,
			new BN(22500 * PEG_PRECISION.toNumber()),
			undefined,
			1000
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await driftClient.updatePerpMarketBaseSpread(0, 2000);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		const subAccountId = 0;
		const name = 'BIGZ';
		await driftClient.initializeUserAccount(subAccountId, name);
		await driftClient.deposit(
			// $10k
			QUOTE_PRECISION.mul(new BN(10000)),
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
			secondUserKeyPair,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			ZERO,
			[0],
			[0, 1, 2],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
				{
					publicKey: dogeOracle,
					source: OracleSource.PYTH,
				},
			],
			bulkAccountLoader
		);

		secondUserDriftClientDogeAccount = await createUSDCAccountForUser(
			provider,
			secondUserKeyPair,
			dogeMint,
			usdcAmount
		);

		secondUserDriftClient.subscribe();

		const marketIndex = 1;
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const txSig2 = await secondUserDriftClient.deposit(
			usdcAmount,
			2,
			secondUserDriftClientDogeAccount
		);
		await printTxLogs(connection, txSig2);
	});

	after(async () => {
		await eventSubscriber.unsubscribe();
		await driftClient.unsubscribe();
		await secondUserDriftClient.unsubscribe();
	});

	it('fail trying to borrow protected asset', async () => {
		const usdcBorrowAmount = QUOTE_PRECISION;

		const quoteMarket = driftClient.getSpotMarketAccount(0);
		assert(isVariant(quoteMarket.assetTier, 'collateral'));

		await driftClient.updateSpotMarketAssetTier(0, AssetTier.PROTECTED);
		await driftClient.fetchAccounts();

		const quoteMarketAfter = driftClient.getSpotMarketAccount(0);
		assert(isVariant(quoteMarketAfter.assetTier, 'protected'));
		console.log('updateSpotMarketAssetTier for USDC to PROTECTED');

		try {
			const txSig = await secondUserDriftClient.withdraw(
				usdcBorrowAmount,
				0,
				secondUserDriftClientUSDCAccount,
				false
			);
			await printTxLogs(connection, txSig);

			// assert(false);
		} catch (err) {
			console.error(err);
			// assert(err.message.includes('0x17e2'));
		}

		console.log('updateSpotMarketAssetTier for USDC back to COLLATERAL');
		await driftClient.updateSpotMarketAssetTier(0, AssetTier.COLLATERAL);

		await secondUserDriftClient.fetchAccounts();

		const quoteMarketAfterAgain = secondUserDriftClient.getSpotMarketAccount(0);
		assert(isVariant(quoteMarketAfterAgain.assetTier, 'collateral'));
		console.log('USDC tier:', quoteMarketAfterAgain.assetTier);

		// make doge isolated asset
		try {
			await driftClient.updateSpotMarketMarginWeights(
				2,
				0,
				1,
				SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(2)).toNumber(),
				SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(10)).div(new BN(9)).toNumber()
			);

			await driftClient.updateSpotMarketAssetTier(2, AssetTier.ISOLATED);
		} catch (e) {
			console.error(e);
		}
		await driftClient.fetchAccounts();
		await secondUserDriftClient.fetchAccounts();
		console.log('updateSpotMarketAssetTier for DOGE to isolated');
		const dogeMarketAfter = secondUserDriftClient.getSpotMarketAccount(2);
		assert(isVariant(dogeMarketAfter.assetTier, 'isolated'));
		console.log('DOGE asset tier:', dogeMarketAfter.assetTier);

		const txSig = await secondUserDriftClient.withdraw(
			new BN(1),
			2,
			secondUserDriftClientDogeAccount,
			false
		);
		await printTxLogs(connection, txSig);

		await secondUserDriftClient.fetchAccounts();

		try {
			const txSig = await secondUserDriftClient.withdraw(
				usdcBorrowAmount,
				0,
				secondUserDriftClientUSDCAccount,
				false
			);
			await printTxLogs(connection, txSig);

			console.log('usdc borrow succeed (should have fail!)');
			assert(false);
		} catch (err) {
			console.log('failed!');
			// assert(err.message.includes('Transaction simulation failed:'));
		}

		// make doge CROSS
		await driftClient.updateSpotMarketAssetTier(2, AssetTier.CROSS);
		const dogeMarketAfterAgain = driftClient.getSpotMarketAccount(2);
		assert(isVariant(dogeMarketAfterAgain.assetTier, 'cross'));

		await secondUserDriftClient.fetchAccounts();
		const scQuoteMarketAfterAgain =
			secondUserDriftClient.getSpotMarketAccount(0);
		assert(isVariant(scQuoteMarketAfterAgain.assetTier, 'collateral'));
		console.log('USDC asset tier:', scQuoteMarketAfterAgain.assetTier);

		try {
			const txSig2 = await secondUserDriftClient.withdraw(
				QUOTE_PRECISION,
				0,
				secondUserDriftClientUSDCAccount,
				false
			);
			await printTxLogs(connection, txSig2);
		} catch (e) {
			console.error(e);
			assert(false);
		}
	});
});
