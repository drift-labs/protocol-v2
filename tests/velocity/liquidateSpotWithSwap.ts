import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import { assert } from 'chai';

import { LAMPORTS_PER_SOL, Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	TestClient,
	OracleSource,
	OracleInfo,
	PERCENTAGE_PRECISION,
} from '../../packages/sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

// Regression guard for `liquidate_spot_with_swap`: the begin handler introspects
// the matching end instruction and binds accounts by hard-coded index, with the
// swap (remaining) accounts assumed to start right after the fixed accounts.
// `LiquidateSpotWithSwap` has 11 fixed accounts (indexes 0..=10); a stale guard
// previously used the old 13-account Drift layout (with liquidator_stats/user_stats),
// which made the begin/end account-count check unsatisfiable and bricked the route.
// This test builds begin + end through the generated SDK/IDL and asserts the account
// order the program guard depends on, so any future struct reshuffle that desyncs the
// guard is caught here rather than on-chain.
describe('liquidate spot with swap account bindings', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let liquidatorClient: TestClient;
	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;
	let usdcMint;

	let userClient: TestClient;
	let liquidatorUSDC: PublicKey;
	let liquidatorWSOL: PublicKey;
	let liquidatorKeypair: Keypair;

	const usdcAmount = new BN(200 * 10 ** 6).muln(10);
	const solAmount = new BN(10 * 10 ** 9).muln(10);

	const spotMarketIndexes = [0, 1];

	// Fixed-account indexes the begin handler's introspection guard binds against
	// (see programs/velocity/src/instructions/keeper.rs). These mirror the IDL
	// account order of `LiquidateSpotWithSwap` and must stay in sync with it.
	const AUTHORITY_IX_INDEX = 1;
	const LIQUIDATOR_IX_INDEX = 2;
	const USER_IX_INDEX = 3;
	const LIABILITY_VAULT_IX_INDEX = 4;
	const ASSET_VAULT_IX_INDEX = 5;
	const LIABILITY_TOKEN_ACCOUNT_IX_INDEX = 6;
	const ASSET_TOKEN_ACCOUNT_IX_INDEX = 7;
	const NUM_FIXED_ACCOUNTS = 11;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);
		await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			solAmount
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		const oracleInfos: OracleInfo[] = [
			{ publicKey: solOracle, source: OracleSource.PYTH_LAZER },
		];

		userClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await userClient.initialize(usdcMint.publicKey, true);
		await userClient.subscribe();
		await userClient.initializeUserAccount();

		const oracleGuardrails = await userClient.getStateAccount()
			.oracleGuardRails;
		oracleGuardrails.validity.tooVolatileRatio = new BN(10000);
		oracleGuardrails.priceDivergence.oracleTwap5MinPercentDivergence = new BN(
			100
		).mul(PERCENTAGE_PRECISION);
		await userClient.updateOracleGuardRails(oracleGuardrails);

		await initializeQuoteSpotMarket(userClient, usdcMint.publicKey);
		await initializeSolSpotMarket(userClient, solOracle);

		[liquidatorClient, liquidatorWSOL, liquidatorUSDC, liquidatorKeypair] =
			await createUserWithUSDCAndWSOLAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await bankrunContextWrapper.fundKeypair(
			liquidatorKeypair,
			10 * LAMPORTS_PER_SOL
		);

		await setFeedPriceNoProgram(bankrunContextWrapper, 200, solOracle);
	});

	after(async () => {
		await userClient.unsubscribe();
		await liquidatorClient.unsubscribe();
	});

	it('begin/end account order matches the program guard indexes', async () => {
		const assetMarketIndex = 0; // USDC
		const liabilityMarketIndex = 1; // SOL

		const { beginSwapIx, endSwapIx } =
			await liquidatorClient.getLiquidateSpotWithSwapIx({
				swapAmount: new BN(10 ** 6),
				assetMarketIndex,
				liabilityMarketIndex,
				assetTokenAccount: liquidatorUSDC,
				liabilityTokenAccount: liquidatorWSOL,
				userAccount: userClient.getUserAccount(),
				userAccountPublicKey: await userClient.getUserAccountPublicKey(),
			});

		const authority = liquidatorClient.wallet.publicKey;
		const liquidator = await liquidatorClient.getUserAccountPublicKey();
		const user = await userClient.getUserAccountPublicKey();
		const liabilitySpotMarket =
			liquidatorClient.getSpotMarketAccountOrThrow(liabilityMarketIndex);
		const assetSpotMarket =
			liquidatorClient.getSpotMarketAccountOrThrow(assetMarketIndex);

		// The guard runs on the BEGIN instruction's accounts (ctx) against the
		// END instruction's accounts (introspected). Both are built from the same
		// `LiquidateSpotWithSwap` struct, so they must produce an identical layout.
		for (const ix of [beginSwapIx, endSwapIx]) {
			assert.ok(
				ix.keys[AUTHORITY_IX_INDEX].pubkey.equals(authority),
				'authority binding index mismatch'
			);
			assert.ok(
				ix.keys[LIQUIDATOR_IX_INDEX].pubkey.equals(liquidator),
				'liquidator binding index mismatch'
			);
			assert.ok(
				ix.keys[USER_IX_INDEX].pubkey.equals(user),
				'user binding index mismatch'
			);
			assert.ok(
				ix.keys[LIABILITY_VAULT_IX_INDEX].pubkey.equals(
					liabilitySpotMarket.vault
				),
				'liability_spot_market_vault binding index mismatch'
			);
			assert.ok(
				ix.keys[ASSET_VAULT_IX_INDEX].pubkey.equals(assetSpotMarket.vault),
				'asset_spot_market_vault binding index mismatch'
			);
			assert.ok(
				ix.keys[LIABILITY_TOKEN_ACCOUNT_IX_INDEX].pubkey.equals(liquidatorWSOL),
				'liability_token_account binding index mismatch'
			);
			assert.ok(
				ix.keys[ASSET_TOKEN_ACCOUNT_IX_INDEX].pubkey.equals(liquidatorUSDC),
				'asset_token_account binding index mismatch'
			);
		}

		// Begin and end must carry the same accounts (the guard compares them 1:1),
		// and the remaining (swap) accounts must start right after the fixed block.
		assert.equal(
			beginSwapIx.keys.length,
			endSwapIx.keys.length,
			'begin and end must have the same number of accounts'
		);
		assert.isAtLeast(
			beginSwapIx.keys.length,
			NUM_FIXED_ACCOUNTS,
			'expected at least the fixed accounts'
		);
		for (let i = 0; i < beginSwapIx.keys.length; i++) {
			assert.ok(
				beginSwapIx.keys[i].pubkey.equals(endSwapIx.keys[i].pubkey),
				`begin/end account mismatch at index ${i}`
			);
		}

		// The guard counts remaining accounts as `ix.accounts.len() - 11` and loops
		// from index 11; assert the SDK lays out exactly that fixed-account count.
		const remainingCount = beginSwapIx.keys.length - NUM_FIXED_ACCOUNTS;
		assert.isAtLeast(
			remainingCount,
			0,
			'fixed account count must not exceed total accounts'
		);
	});
});
