import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { AccountInfo, Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	UserStatsAccount,
	getFuelOverflowAccountPublicKey,
	parseLogs,
	FuelOverflowStatus,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/bulkAccountLoader/testBulkAccountLoader';
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

	it('can reset fuel season for user with no sweep account', async () => {
		const userStatsKey = userDriftClient.getUserStatsAccountPublicKey();
		const userStatsBefore = await getUserStatsDecoded(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey
		);
		assert.isFalse(
			(userStatsBefore.data.fuelOverflowStatus & FuelOverflowStatus.Exists) ===
				FuelOverflowStatus.Exists,
			'FuelOverflow account should not exist'
		);
		userStatsBefore.data.fuelTaker = 1_000_000_000;
		userStatsBefore.data.fuelMaker = 2_000_000_000;
		const expectedTotalFuel =
			userStatsBefore.data.fuelTaker + userStatsBefore.data.fuelMaker;
		await overWriteUserStats(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey,
			userStatsBefore
		);

		const txSig = await userDriftClient.resetFuelSeason(
			false,
			userDriftClient.wallet.publicKey
		);
		const tx = await bankrunContextWrapper.connection.getTransaction(txSig);

		// check proper logs emitted
		const logs = parseLogs(chProgram, tx.meta.logMessages);
		assert.equal(logs.length, 1);
		assert.isTrue(logs[0].name === 'FuelSeasonRecord');
		assert.isTrue(
			(logs[0].data.authority as PublicKey).equals(
				userDriftClient.wallet.publicKey
			),
			'Authority should be the user'
		);
		assert.isTrue(
			new BN(logs[0].data.fuelTotal as string).eq(new BN(expectedTotalFuel)),
			`Fuel total should be the expected total, got ${logs[0].data.fuelTotal}, expected ${expectedTotalFuel}`
		);

		// check user stats reset
		const userStatsAfter = await getUserStatsDecoded(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey
		);
		assert.equal(userStatsAfter.data.fuelTaker, 0);
		assert.equal(userStatsAfter.data.fuelMaker, 0);
	});

	it('cannot init fuel sweep with low fuel amount', async () => {
		let success = false;
		try {
			userDriftClient.txParams.computeUnits = 600_000;
			await userDriftClient.initializeFuelOverflow(
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
		const userStatsBefore = await getUserStatsDecoded(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey
		);
		userStatsBefore.data.fuelTaker = 4_000_000_001;
		userStatsBefore.data.fuelMaker = 4_000_000_000;
		await overWriteUserStats(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey,
			userStatsBefore
		);

		const userStatsAfter = await getUserStatsDecoded(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey
		);
		assert.equal(userStatsAfter.data.fuelTaker, 4_000_000_001);
		assert.equal(userStatsAfter.data.fuelMaker, 4_000_000_000);

		// use a different CU limit to prevent race condition of sending two identical transactions
		userDriftClient.txParams.computeUnits = 600_001;
		await userDriftClient.initializeFuelOverflow(
			userDriftClient.wallet.publicKey
		);
		await userDriftClient.sweepFuel(userDriftClient.wallet.publicKey);

		// check
		const userStatsAfterSweep =
			await userDriftClient.program.account.userStats.fetch(userStatsKey);
		assert.equal(userStatsAfterSweep.fuelTaker, 0);
		assert.equal(userStatsAfterSweep.fuelMaker, 0);
		assert.isTrue(
			(userStatsAfterSweep.fuelOverflowStatus as number &
				FuelOverflowStatus.Exists) === FuelOverflowStatus.Exists
		);

		const userFuelSweepAccount =
			await userDriftClient.program.account.fuelOverflow.fetch(
				getFuelOverflowAccountPublicKey(
					userDriftClient.program.programId,
					userDriftClient.wallet.publicKey
				)
			);
		assert.isTrue(
			// @ts-ignore
			userFuelSweepAccount.authority.equals(userDriftClient.wallet.publicKey)
		);
		assert.equal(userFuelSweepAccount.fuelTaker, 4_000_000_001);
		assert.equal(userFuelSweepAccount.fuelMaker, 4_000_000_000);
	});

	it('can reset fuel season for user with sweep account', async () => {
		const userStatsKey = userDriftClient.getUserStatsAccountPublicKey();
		const userStatsBefore = await getUserStatsDecoded(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey
		);
		assert.isTrue(
			(userStatsBefore.data.fuelOverflowStatus & FuelOverflowStatus.Exists) ===
				FuelOverflowStatus.Exists,
			'FuelSweep account should exist'
		);

		const userFuelSweepAccount =
			await userDriftClient.program.account.fuelOverflow.fetch(
				getFuelOverflowAccountPublicKey(
					userDriftClient.program.programId,
					userDriftClient.wallet.publicKey
				)
			);
		assert.equal(userFuelSweepAccount.fuelTaker, 4_000_000_001);
		assert.equal(userFuelSweepAccount.fuelMaker, 4_000_000_000);
		const expectedTotalFuel = 8_000_000_001;

		const txSig = await userDriftClient.resetFuelSeason(
			true,
			userDriftClient.wallet.publicKey
		);
		const tx = await bankrunContextWrapper.connection.getTransaction(txSig);

		// check proper logs emitted
		const logs = parseLogs(chProgram, tx.meta.logMessages);
		assert.equal(logs.length, 2);
		assert.isTrue(
			(logs[0].data.authority as PublicKey).equals(
				userDriftClient.wallet.publicKey
			),
			'Authority should be the user'
		);
		assert.isTrue(logs[0].name === 'FuelSweepRecord');
		assert.isTrue(
			(logs[1].data.authority as PublicKey).equals(
				userDriftClient.wallet.publicKey
			),
			'Authority should be the user'
		);

		assert.isTrue(
			new BN(logs[1].data.fuelTotal as string).eq(new BN(expectedTotalFuel)),
			`Fuel total should be the expected total, got ${logs[1].data.fuelTotal}, expected ${expectedTotalFuel}`
		);
		assert.isTrue(logs[1].name === 'FuelSeasonRecord');

		// check user stats and sweep accounts reset
		const userStatsAfter = await getUserStatsDecoded(
			userDriftClient,
			bankrunContextWrapper,
			userStatsKey
		);
		assert.equal(userStatsAfter.data.fuelTaker, 0);
		assert.equal(userStatsAfter.data.fuelMaker, 0);

		const userFuelSweepAccountAfter =
			await userDriftClient.program.account.fuelOverflow.fetch(
				getFuelOverflowAccountPublicKey(
					userDriftClient.program.programId,
					userDriftClient.wallet.publicKey
				)
			);
		assert.equal(userFuelSweepAccountAfter.fuelTaker, 0);
		assert.equal(userFuelSweepAccountAfter.fuelMaker, 0);
	});
});

async function getUserStatsDecoded(
	driftClient: TestClient,
	bankrunContextWrapper: BankrunContextWrapper,
	userStatsKey: PublicKey
): Promise<AccountInfo<UserStatsAccount>> {
	const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
		userStatsKey
	);
	const userStatsBefore: UserStatsAccount =
		driftClient.program.account.userStats.coder.accounts.decode(
			'UserStats',
			accountInfo.data
		);

	// @ts-ignore
	accountInfo.data = userStatsBefore;
	// @ts-ignore
	return accountInfo;
}

async function overWriteUserStats(
	driftClient: TestClient,
	bankrunContextWrapper: BankrunContextWrapper,
	userStatsKey: PublicKey,
	userStats: AccountInfo<UserStatsAccount>
) {
	bankrunContextWrapper.context.setAccount(userStatsKey, {
		executable: userStats.executable,
		owner: userStats.owner,
		lamports: userStats.lamports,
		data: await driftClient.program.account.userStats.coder.accounts.encode(
			'UserStats',
			userStats.data
		),
		rentEpoch: userStats.rentEpoch,
	});
}
