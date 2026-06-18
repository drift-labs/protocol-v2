import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	OracleInfo,
} from '../../packages/sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
	getMaxWithdrawGuardThreshold,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { ZERO } from '../../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('spot deposit and withdraw', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserVelocityClient: TestClient;
	let firstUserVelocityClientWSOLAccount: PublicKey;
	let firstUserVelocityClientUSDCAccount: PublicKey;

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientWSOLAccount: PublicKey;

	const usdcAmount = new BN(10 ** 6 / 20);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	const solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, bankrunContextWrapper);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 30);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH_LAZER }];

		admin = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
		await firstUserVelocityClient.unsubscribe();
		await secondUserVelocityClient.unsubscribe();
	});

	it('Initialize USDC Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)).toNumber(); // 5000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
		await admin.initializeSpotMarket(
			usdcMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			PublicKey.default,
			OracleSource.QUOTE_ASSET,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);
		const txSig = await admin.updateWithdrawGuardThreshold(
			0,
			await getMaxWithdrawGuardThreshold(admin, 0)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
	});

	it('Initialize SOL Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)).toNumber(); // 5000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(8))
			.div(new BN(10))
			.toNumber();
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(9))
			.div(new BN(10))
			.toNumber();
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(12))
			.div(new BN(10))
			.toNumber();
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
			new BN(11)
		)
			.div(new BN(10))
			.toNumber();

		await admin.initializeSpotMarket(
			NATIVE_MINT,
			optimalUtilization,
			optimalRate,
			maxRate,
			solOracle,
			OracleSource.PYTH_LAZER,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);

		const txSig = await admin.updateWithdrawGuardThreshold(
			1,
			await getMaxWithdrawGuardThreshold(admin, 1)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
	});

	it('First User Deposit USDC', async () => {
		[
			firstUserVelocityClient,
			firstUserVelocityClientWSOLAccount,
			firstUserVelocityClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			ZERO,
			usdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader
		);

		const marketIndex = 0;
		await sleep(100);
		await firstUserVelocityClient.fetchAccounts();
		const txSig = await firstUserVelocityClient.deposit(
			usdcAmount,
			marketIndex,
			firstUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('Second User Deposit SOL', async () => {
		[secondUserVelocityClient, secondUserVelocityClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				solAmount,
				ZERO,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		const marketIndex = 1;
		const txSig = await secondUserVelocityClient.deposit(
			solAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('First User Borrow SOL', async () => {
		const marketIndex = 1;
		const withdrawAmount = solAmount.div(new BN(1000));
		const txSig = await firstUserVelocityClient.withdraw(
			withdrawAmount,
			marketIndex,
			firstUserVelocityClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('Force delete', async () => {
		await firstUserVelocityClient.fetchAccounts();
		// @ts-ignore
		await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			secondUserVelocityClient.wallet,
			new BN(LAMPORTS_PER_SOL)
		);
		// @ts-ignore
		await secondUserVelocityClient.sendTransaction(
			await secondUserVelocityClient.buildTransaction([
				await secondUserVelocityClient.createAssociatedTokenAccountIdempotentInstruction(
					await secondUserVelocityClient.getAssociatedTokenAccount(0),
					secondUserVelocityClient.wallet.publicKey,
					secondUserVelocityClient.wallet.publicKey,
					secondUserVelocityClient.getSpotMarketAccount(0).mint
				),
			])
		);
		const ixs = [];
		ixs.push(
			await secondUserVelocityClient.getForceDeleteUserIx(
				await firstUserVelocityClient.getUserAccountPublicKey(),
				await firstUserVelocityClient.getUserAccount()
			)
		);
		// @ts-ignore
		await secondUserVelocityClient.sendTransaction(
			await secondUserVelocityClient.buildTransaction(ixs)
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			await firstUserVelocityClient.getUserAccountPublicKey()
		);
		assert(accountInfo === null);
	});
});
