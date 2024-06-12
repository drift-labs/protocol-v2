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
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	AssetTier,
	SPOT_MARKET_WEIGHT_PRECISION,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	// setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	createUSDCAccountForUser,
	// getFeedData,
	// sleep,
} from './testHelpers';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';
import { ContractTier } from '../sdk';


describe('asset tiers', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let dogeMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;
	let dogeOracle: PublicKey;
	const usdcAmount = new BN(10000 * 10 ** 6); //1M

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;
	let secondUserDriftClientDogeAccount: PublicKey;
	let secondUserKeyPair: Keypair;

	const solAmount = new BN(100 * 10 ** 9);

	before(async () => {
		const context = await startAnchor("", [], []);

		const bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		dogeMint = await mockUSDCMint(bankrunContextWrapper);

		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			bankrunContextWrapper,
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 22500); // a future we all need to believe in
		dogeOracle = await mockOracleNoProgram(bankrunContextWrapper, 0.05);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			// activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: false,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		// await driftClient.initializeUserAccount(0);

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
			ContractTier.A,
			1000,
			500,
			undefined,
			undefined,
			undefined,
			true,
			2000,
			5000
		);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		const subAccountId = 0;
		const name = 'BIGZ';
		await driftClient.initializeUserAccount(subAccountId, name);
		const depositAmount = driftClient.convertToSpotPrecision(QUOTE_SPOT_MARKET_INDEX, 1);
		console.log(`\n\n\n\n\n\n depositing here: ${depositAmount}`);
		await driftClient.deposit(
			// $10k
			depositAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
			secondUserKeyPair,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
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
			bankrunContextWrapper,
			secondUserKeyPair,
			dogeMint,
			usdcAmount
		);

		secondUserDriftClient.subscribe();

		const marketIndex = 1;
		console.log("\n\n\n\n\n\n\n\n\n\n FIRST depositing for second user: " + solAmount);
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		// await printTxLogs(connection, txSig);

		console.log("\n\n\n\n\n\n\n\n\n\n SECOND depositing for second user: " + usdcAmount)
		const txSig2 = await secondUserDriftClient.deposit(
			usdcAmount,
			2,
			secondUserDriftClientDogeAccount
		);
		// await printTxLogs(connection, txSig2);
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
			// await printTxLogs(connection, txSig);

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
		// await printTxLogs(connection, txSig);

		await secondUserDriftClient.fetchAccounts();

		try {
			const txSig = await secondUserDriftClient.withdraw(
				usdcBorrowAmount,
				0,
				secondUserDriftClientUSDCAccount,
				false
			);
			// await printTxLogs(connection, txSig);

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
			// await printTxLogs(connection, txSig2);
		} catch (e) {
			console.error(e);
			assert(false);
		}
	});
});
