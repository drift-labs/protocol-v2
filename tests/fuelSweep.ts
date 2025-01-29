import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	User,
	Wallet,
	EventSubscriber,
	OracleSource,
	getSwiftUserAccountPublicKey,
	QUOTE_PRECISION,
	UserStats,
	UserStatsAccount,
	getFuelSweepAccountPublicKey,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { PEG_PRECISION } from '../sdk/src';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
dotenv.config();

describe('fuel sweep', () => {
	const chProgram = anchor.workspace.Drift as Program;
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let userDriftClient: TestClient;
	let usdcMint;
	let userUSDCAccount;
	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		const context = await startAnchor('', [], []);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
		const wallet = new Wallet(keypair);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		userDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			// userStats: true,
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			oracleInfos: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userDriftClient.initialize(usdcMint.publicKey, true);
		await userDriftClient.subscribe();
		await initializeQuoteSpotMarket(userDriftClient, usdcMint.publicKey);
		await userDriftClient.initializeUserAccountAndDepositCollateral(
			QUOTE_PRECISION,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await userDriftClient.unsubscribe();
	});

	it('cannot init fuel sweep with low fuel amount', async () => {
		let success = false;
		try {
			const tx = await userDriftClient.initializeFuelSweep(
				userDriftClient.wallet.publicKey
			);
			success = true;
		} catch (e) {
			assert.isTrue(e.message.includes('0x18a6'));
		}
		assert.isFalse(success, 'Should have failed to init a fuel account');
	});

	it('can init fuel sweep with high fuel amount', async () => {
		// overwrite user stats with high fuel
		const userStatsKey = userDriftClient.getUserStatsAccountPublicKey();
		const userStatsDataBefore =
			await bankrunContextWrapper.connection.getAccountInfo(userStatsKey);
		const userStatsBefore: UserStatsAccount =
			userDriftClient.program.account.userStats.coder.accounts.decode(
				'UserStats',
				userStatsDataBefore.data
			);

		userStatsBefore.fuelTaker = 4_000_000_001;
		userStatsBefore.fuelMaker = 4_000_000_000;

		const userStatsDataAfter: Buffer =
			await userDriftClient.program.account.userStats.coder.accounts.encode(
				'UserStats',
				userStatsBefore
			);
		bankrunContextWrapper.context.setAccount(userStatsKey, {
			executable: userStatsDataBefore.executable,
			owner: userStatsDataBefore.owner,
			lamports: userStatsDataBefore.lamports,
			data: userStatsDataAfter,
			rentEpoch: userStatsDataBefore.rentEpoch,
		});

		const userStatsAfter =
			await userDriftClient.program.account.userStats.fetch(userStatsKey);
		assert.equal(userStatsAfter.fuelTaker, 4_000_000_001);
		assert.equal(userStatsAfter.fuelMaker, 4_000_000_000);

		await userDriftClient.initializeFuelSweep(userDriftClient.wallet.publicKey);
		await userDriftClient.sweepFuel(userDriftClient.wallet.publicKey);

		const userStatsAfterSweep =
			await userDriftClient.program.account.userStats.fetch(userStatsKey);
		assert.equal(userStatsAfterSweep.fuelTaker, 0);
		assert.equal(userStatsAfterSweep.fuelMaker, 0);

		const userFuelSweepAccount =
			await userDriftClient.program.account.fuelSweep.fetch(
				getFuelSweepAccountPublicKey(
					userDriftClient.program.programId,
					userDriftClient.wallet.publicKey
				)
			);
		// @ts-ignore
		assert.isTrue(
			userFuelSweepAccount.authority.equals(userDriftClient.wallet.publicKey)
		);
		assert.equal(userFuelSweepAccount.fuelTaker, 4_000_000_001);
		assert.equal(userFuelSweepAccount.fuelMaker, 4_000_000_000);
	});
});
