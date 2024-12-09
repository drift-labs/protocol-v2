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
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { QUOTE_PRECISION, ZERO } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('spot deposit and withdraw', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserDriftClient: TestClient;
	let firstUserDriftClientWSOLAccount: PublicKey;
	let firstUserDriftClientUSDCAccount: PublicKey;

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;

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
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

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
		await firstUserDriftClient.unsubscribe();
		await secondUserDriftClient.unsubscribe();
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
			new BN(10 ** 10).mul(QUOTE_PRECISION)
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
			OracleSource.PYTH,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);

		const txSig = await admin.updateWithdrawGuardThreshold(
			1,
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
	});

	it('First User Deposit USDC', async () => {
		[
			firstUserDriftClient,
			firstUserDriftClientWSOLAccount,
			firstUserDriftClientUSDCAccount,
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
		await firstUserDriftClient.fetchAccounts();
		const txSig = await firstUserDriftClient.deposit(
			usdcAmount,
			marketIndex,
			firstUserDriftClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('Second User Deposit SOL', async () => {
		[secondUserDriftClient, secondUserDriftClientWSOLAccount] =
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
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('First User Borrow SOL', async () => {
		const marketIndex = 1;
		const withdrawAmount = solAmount.div(new BN(1000));
		const txSig = await firstUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			firstUserDriftClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('Force delete', async () => {
		await firstUserDriftClient.fetchAccounts();
		// @ts-ignore
		await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			secondUserDriftClient.wallet,
			new BN(LAMPORTS_PER_SOL)
		);
		// @ts-ignore
		await secondUserDriftClient.sendTransaction(
			await secondUserDriftClient.buildTransaction([
				await secondUserDriftClient.createAssociatedTokenAccountIdempotentInstruction(
					await secondUserDriftClient.getAssociatedTokenAccount(0),
					secondUserDriftClient.wallet.publicKey,
					secondUserDriftClient.wallet.publicKey,
					secondUserDriftClient.getSpotMarketAccount(0).mint
				),
			])
		);
		const ixs = [];
		ixs.push(
			await secondUserDriftClient.getForceDeleteUserIx(
				await firstUserDriftClient.getUserAccountPublicKey(),
				await firstUserDriftClient.getUserAccount()
			)
		);
		// @ts-ignore
		await secondUserDriftClient.sendTransaction(
			await secondUserDriftClient.buildTransaction(ixs)
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			await firstUserDriftClient.getUserAccountPublicKey()
		);
		assert(accountInfo === null);
	});
});
