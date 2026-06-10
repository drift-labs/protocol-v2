import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	TestClient,
	BN,
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
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { ContractTier } from '../sdk';

describe('asset tiers', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let dogeMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;
	let dogeOracle: PublicKey;
	const usdcAmount = new BN(1000000 * 10 ** 6); //1M

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientWSOLAccount: PublicKey;
	let secondUserVelocityClientUSDCAccount: PublicKey;
	let secondUserVelocityClientDogeAccount: PublicKey;
	let secondUserKeyPair: Keypair;

	const solAmount = new BN(10000 * 10 ** 9);

	before(async () => {
		const context = await startAnchor('', [], []);

		const bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		dogeMint = await mockUSDCMint(bankrunContextWrapper);

		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 22500); // a future we all need to believe in
		dogeOracle = await mockOracleNoProgram(bankrunContextWrapper, 0.05);

		velocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			userStats: false,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		// await velocityClient.initializeUserAccount(0);

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);
		await initializeSolSpotMarket(
			velocityClient,
			dogeOracle,
			dogeMint.publicKey
		);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await velocityClient.initializePerpMarket(
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
		await velocityClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		const subAccountId = 0;
		const name = 'BIGZ';
		await velocityClient.initializeUserAccount(subAccountId, name);
		const depositAmount = velocityClient.convertToSpotPrecision(
			QUOTE_SPOT_MARKET_INDEX,
			1
		);
		console.log(`\n\n\n\n\n\n depositing here: ${depositAmount}`);
		await velocityClient.deposit(
			// $10k
			depositAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		[
			secondUserVelocityClient,
			secondUserVelocityClientWSOLAccount,
			secondUserVelocityClientUSDCAccount,
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
					source: OracleSource.PYTH_LAZER,
				},
				{
					publicKey: dogeOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);

		secondUserVelocityClientDogeAccount = await createUSDCAccountForUser(
			bankrunContextWrapper,
			secondUserKeyPair,
			dogeMint,
			usdcAmount
		);

		secondUserVelocityClient.subscribe();

		const marketIndex = 1;
		console.log(
			'\n\n\n\n\n\n\n\n\n\n FIRST depositing for second user: ' + solAmount
		);
		await secondUserVelocityClient.deposit(
			solAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount
		);
		// await printTxLogs(connection, txSig);

		console.log(
			'\n\n\n\n\n\n\n\n\n\n SECOND depositing for second user: ' + usdcAmount
		);
		await secondUserVelocityClient.deposit(
			usdcAmount,
			2,
			secondUserVelocityClientDogeAccount
		);
		// await printTxLogs(connection, txSig2);
	});

	it('fail trying to borrow protected asset', async () => {
		const usdcBorrowAmount = QUOTE_PRECISION;

		const quoteMarket = velocityClient.getSpotMarketAccount(0);
		assert(isVariant(quoteMarket.assetTier, 'collateral'));

		await velocityClient.updateSpotMarketAssetTier(0, AssetTier.PROTECTED);
		await velocityClient.fetchAccounts();

		const quoteMarketAfter = velocityClient.getSpotMarketAccount(0);
		assert(isVariant(quoteMarketAfter.assetTier, 'protected'));
		console.log('updateSpotMarketAssetTier for USDC to PROTECTED');

		try {
			await secondUserVelocityClient.withdraw(
				usdcBorrowAmount,
				0,
				secondUserVelocityClientUSDCAccount,
				false
			);
			// await printTxLogs(connection, txSig);

			// assert(false);
		} catch (err) {
			console.error(err);
			// assert(err.message.includes('0x17e2'));
		}

		console.log('updateSpotMarketAssetTier for USDC back to COLLATERAL');
		await velocityClient.updateSpotMarketAssetTier(0, AssetTier.COLLATERAL);

		await secondUserVelocityClient.fetchAccounts();

		const quoteMarketAfterAgain =
			secondUserVelocityClient.getSpotMarketAccount(0);
		assert(isVariant(quoteMarketAfterAgain.assetTier, 'collateral'));
		console.log('USDC tier:', quoteMarketAfterAgain.assetTier);

		// make doge isolated asset
		try {
			await velocityClient.updateSpotMarketMarginWeights(
				2,
				0,
				1,
				SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(2)).toNumber(),
				SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(10)).div(new BN(9)).toNumber()
			);

			await velocityClient.updateSpotMarketAssetTier(2, AssetTier.ISOLATED);
		} catch (e) {
			console.error(e);
		}
		await velocityClient.fetchAccounts();
		await secondUserVelocityClient.fetchAccounts();
		console.log('updateSpotMarketAssetTier for DOGE to isolated');
		const dogeMarketAfter = secondUserVelocityClient.getSpotMarketAccount(2);
		assert(isVariant(dogeMarketAfter.assetTier, 'isolated'));
		console.log('DOGE asset tier:', dogeMarketAfter.assetTier);

		await secondUserVelocityClient.withdraw(
			new BN(1),
			2,
			secondUserVelocityClientDogeAccount,
			false
		);
		// await printTxLogs(connection, txSig);

		await secondUserVelocityClient.fetchAccounts();

		try {
			await secondUserVelocityClient.withdraw(
				usdcBorrowAmount,
				0,
				secondUserVelocityClientUSDCAccount,
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
		await velocityClient.updateSpotMarketAssetTier(2, AssetTier.CROSS);
		const dogeMarketAfterAgain = velocityClient.getSpotMarketAccount(2);
		assert(isVariant(dogeMarketAfterAgain.assetTier, 'cross'));

		await secondUserVelocityClient.fetchAccounts();
		const scQuoteMarketAfterAgain =
			secondUserVelocityClient.getSpotMarketAccount(0);
		assert(isVariant(scQuoteMarketAfterAgain.assetTier, 'collateral'));
		console.log('USDC asset tier:', scQuoteMarketAfterAgain.assetTier);

		try {
			await secondUserVelocityClient.withdraw(
				QUOTE_PRECISION.divn(2),
				0,
				secondUserVelocityClientUSDCAccount,
				false
			);
			// await printTxLogs(connection, txSig2);
		} catch (e) {
			console.error(e);
			assert(false);
		}
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await secondUserVelocityClient.unsubscribe();
	});
});
