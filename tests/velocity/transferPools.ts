import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	OracleInfo,
	MarketStatus,
} from '../../packages/sdk/src';

import {
	createUserWithUSDCAccount,
	createUserWithUSDCAndWSOLAccount,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
	getMaxWithdrawGuardThreshold,
} from './testHelpers';
import { ZERO } from '../../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import { NATIVE_MINT } from '@solana/spl-token';

describe('spot deposit and withdraw', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserVelocityClient: TestClient;
	let firstUserVelocityClientUSDCAccount: PublicKey;

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientWSOLAccount: PublicKey;
	let secondUserVelocityClientUSDCAccount: PublicKey;

	const solAmount = new BN(1 * 10 ** 9);

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

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
		spotMarketIndexes = [0, 1, 2, 3];
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

	it('Initialize USDC Markets', async () => {
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
		await admin.updateWithdrawGuardThreshold(
			0,
			await getMaxWithdrawGuardThreshold(admin, 0)
		);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(0);
		assert(spotMarket.poolId === 0);

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
			maintenanceLiabilityWeight,
			undefined,
			undefined,
			undefined,
			false
		);
		await admin.updateSpotMarketPoolId(1, 1);
		await admin.updateSpotMarketStatus(1, MarketStatus.ACTIVE);
		await admin.updateWithdrawGuardThreshold(
			1,
			await getMaxWithdrawGuardThreshold(admin, 1)
		);
		await admin.fetchAccounts();
		await admin.fetchAccounts();
		const spotMarket1 = await admin.getSpotMarketAccount(1);
		assert(spotMarket1.poolId === 1);
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
			2,
			await getMaxWithdrawGuardThreshold(admin, 2)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(2);
		assert(spotMarket.marketIndex === 2);

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
			maintenanceLiabilityWeight,
			undefined,
			undefined,
			undefined,
			false
		);

		await admin.updateSpotMarketPoolId(3, 1);
		await admin.updateSpotMarketStatus(3, MarketStatus.ACTIVE);
		await admin.updateWithdrawGuardThreshold(
			3,
			await getMaxWithdrawGuardThreshold(admin, 3)
		);
		await admin.fetchAccounts();
		const spotMarket1 = await admin.getSpotMarketAccount(3);
		assert(spotMarket1.poolId === 1);
	});

	it('First User Deposit USDC Markets', async () => {
		[firstUserVelocityClient, firstUserVelocityClientUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount.muln(2),
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await sleep(100);
		await firstUserVelocityClient.fetchAccounts();
		await firstUserVelocityClient.deposit(
			usdcAmount,
			0,
			firstUserVelocityClientUSDCAccount
		);

		await firstUserVelocityClient.initializeUserAccount(1);
		await firstUserVelocityClient.updateUserPoolId([
			{ subAccountId: 1, poolId: 1 },
		]);

		await firstUserVelocityClient.deposit(
			usdcAmount,
			1,
			firstUserVelocityClientUSDCAccount,
			1
		);
	});

	it('Second User Deposit SOL', async () => {
		[
			secondUserVelocityClient,
			secondUserVelocityClientWSOLAccount,
			secondUserVelocityClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
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

		const marketIndex = 2;
		const txSig = await secondUserVelocityClient.deposit(
			solAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('Second User Withdraw First half USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserVelocityClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);
	});

	it('transfer pools', async () => {
		await secondUserVelocityClient.initializeUserAccount(1);
		await secondUserVelocityClient.updateUserPoolId([
			{ subAccountId: 1, poolId: 1 },
		]);
		await sleep(100);
		await secondUserVelocityClient.fetchAccounts();

		await secondUserVelocityClient.transferPools(
			2,
			3,
			0,
			1,
			undefined,
			undefined,
			0,
			1
		);

		secondUserVelocityClient.fetchAccounts();

		await secondUserVelocityClient.switchActiveUser(1);

		const secondUserSolDeposit = await secondUserVelocityClient.getTokenAmount(
			3
		);
		assert(secondUserSolDeposit.eq(solAmount));

		const secondUserUsdcBorrow = await secondUserVelocityClient.getTokenAmount(
			1
		);
		assert(secondUserUsdcBorrow.eq(new BN(-5000090)));

		await secondUserVelocityClient.transferPools(
			3,
			2,
			1,
			0,
			new BN(500000000),
			new BN(2500000),
			1,
			0
		);

		secondUserVelocityClient.fetchAccounts();

		await secondUserVelocityClient.switchActiveUser(1);

		const secondUserSolDeposit2 = await secondUserVelocityClient.getTokenAmount(
			3
		);
		assert(secondUserSolDeposit2.eq(new BN(499999999)));

		const secondUserUsdcBorrow2 = await secondUserVelocityClient.getTokenAmount(
			1
		);
		assert(secondUserUsdcBorrow2.eq(new BN(-2500175)));

		await secondUserVelocityClient.switchActiveUser(0);

		const firstUserSolDeposit = await secondUserVelocityClient.getTokenAmount(
			2
		);
		assert(firstUserSolDeposit.eq(new BN(500000000)));

		const firstUserUsdcBorrow = await secondUserVelocityClient.getTokenAmount(
			0
		);
		assert(firstUserUsdcBorrow.eq(new BN(-2500001)));
	});
});
