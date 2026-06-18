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
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
	getMaxWithdrawGuardThreshold,
} from './testHelpers';
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
	let firstUserVelocityClientUSDCAccount: PublicKey;

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientUSDCAccount: PublicKey;

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

	it('Initialize Markets', async () => {
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
			0,
			await getMaxWithdrawGuardThreshold(admin, 0)
		);
		await admin.fetchAccounts();
		await admin.fetchAccounts();
		const spotMarket1 = await admin.getSpotMarketAccount(1);
		assert(spotMarket1.poolId === 1);
	});

	it('First User Deposit USDC', async () => {
		[firstUserVelocityClient, firstUserVelocityClientUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await sleep(100);
		await firstUserVelocityClient.fetchAccounts();
		await firstUserVelocityClient.deposit(
			usdcAmount.divn(2),
			0,
			firstUserVelocityClientUSDCAccount
		);

		try {
			await firstUserVelocityClient.deposit(
				usdcAmount.divn(2),
				1,
				firstUserVelocityClientUSDCAccount
			);
			assert(false);
		} catch (e) {
			assert(true);
		}
	});

	it('Second User Deposit USDC', async () => {
		[secondUserVelocityClient, secondUserVelocityClientUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await secondUserVelocityClient.updateUserPoolId([
			{ subAccountId: 0, poolId: 1 },
		]);
		await sleep(100);
		await secondUserVelocityClient.fetchAccounts();
		await secondUserVelocityClient.deposit(
			usdcAmount.divn(2),
			1,
			secondUserVelocityClientUSDCAccount
		);

		try {
			await secondUserVelocityClient.deposit(
				usdcAmount.divn(2),
				0,
				secondUserVelocityClientUSDCAccount
			);
			assert(false);
		} catch (e) {
			assert(true);
		}
	});
});
