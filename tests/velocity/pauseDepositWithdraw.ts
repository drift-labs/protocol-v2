import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION,
	SpotBalanceType,
	isVariant,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	OracleInfo,
	ExchangeStatus,
} from '../../packages/sdk/src';

import {
	createUserWithUSDCAccount,
	createUSDCAccountForUser,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
	getMaxWithdrawGuardThreshold,
} from './testHelpers';
import { getBalance } from '../../packages/sdk/src/math/spotBalance';
import {
	createBurnInstruction,
	TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
	SPOT_MARKET_BALANCE_PRECISION,
	SpotOperation,
} from '../../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('spot deposit and withdraw 22', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserVelocityClient: TestClient;
	let firstUserVelocityClientUSDCAccount: PublicKey;
	let firstUserKeyPair: Keypair;

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		const context = (await startAnchor('', [], [])) as any;

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

		usdcMint = await mockUSDCMint(
			bankrunContextWrapper,
			TOKEN_2022_PROGRAM_ID,
			true
		);
		console.log('testhere');
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
			maintenanceLiabilityWeight,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
		const txSig = await admin.updateWithdrawGuardThreshold(
			0,
			await getMaxWithdrawGuardThreshold(admin, 0)
		);
		bankrunContextWrapper.printTxLogs(txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(0);
		assert(spotMarket.marketIndex === 0);
		assert(spotMarket.optimalUtilization === optimalUtilization);
		assert(spotMarket.optimalBorrowRate === optimalRate);
		assert(spotMarket.maxBorrowRate === maxRate);
		assert(
			spotMarket.cumulativeBorrowInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(
			spotMarket.cumulativeDepositInterest.eq(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(spotMarket.initialAssetWeight === initialAssetWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);
		assert(spotMarket.initialLiabilityWeight === initialLiabilityWeight);
		assert(spotMarket.maintenanceAssetWeight === maintenanceAssetWeight);

		assert(admin.getStateAccount().numberOfSpotMarkets === 1);
	});

	it('First User Deposit USDC', async () => {
		[
			firstUserVelocityClient,
			firstUserVelocityClientUSDCAccount,
			firstUserKeyPair,
		] = await createUserWithUSDCAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
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

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(
			spotMarket.depositBalance.eq(
				new BN(10 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		const vaultAmount = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
			).amount.toString()
		);
		assert(vaultAmount.eq(usdcAmount));

		const expectedBalance = getBalance(
			usdcAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const spotPosition =
			firstUserVelocityClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			firstUserVelocityClient.getUserAccount().totalDeposits.eq(usdcAmount)
		);
	});

	it('Deposit rejected when per-market Deposit operation is paused', async () => {
		const marketIndex = 0;

		// Preconditions: global deposits are NOT paused and the market is Active.
		assert(
			(admin.getStateAccount().exchangeStatus &
				ExchangeStatus.DEPOSIT_PAUSED) ===
				0
		);
		const spotMarketBefore = await admin.getSpotMarketAccount(marketIndex);
		assert(isVariant(spotMarketBefore.status, 'active'));

		// Pause ONLY the per-market Deposit operation (withdraw stays open).
		await admin.updateSpotMarketPausedOperations(
			marketIndex,
			SpotOperation.DEPOSIT
		);
		await admin.fetchAccounts();
		assert(
			(await admin.getSpotMarketAccount(marketIndex)).pausedOperations ===
				SpotOperation.DEPOSIT
		);

		// Fund a fresh USDC account so a rejection can only be the pause, not lack of funds.
		const freshUSDCAccount = await createUSDCAccountForUser(
			bankrunContextWrapper,
			firstUserKeyPair,
			usdcMint,
			usdcAmount
		);

		const depositBalanceBefore = (await admin.getSpotMarketAccount(marketIndex))
			.depositBalance;

		await firstUserVelocityClient.fetchAccounts();
		let rejected = false;
		try {
			await firstUserVelocityClient.deposit(
				usdcAmount,
				marketIndex,
				freshUSDCAccount
			);
		} catch (e) {
			rejected = true;
		}
		assert(
			rejected,
			'deposit should be rejected while the market Deposit operation is paused'
		);

		// Market deposit balance is unchanged by the rejected deposit.
		await admin.fetchAccounts();
		assert(
			(await admin.getSpotMarketAccount(marketIndex)).depositBalance.eq(
				depositBalanceBefore
			)
		);

		// Unpausing the Deposit operation lets the same deposit through.
		await admin.updateSpotMarketPausedOperations(marketIndex, 0);
		await firstUserVelocityClient.fetchAccounts();
		await firstUserVelocityClient.deposit(
			usdcAmount,
			marketIndex,
			freshUSDCAccount
		);

		await admin.fetchAccounts();
		assert(
			(await admin.getSpotMarketAccount(marketIndex)).depositBalance.gt(
				depositBalanceBefore
			)
		);
	});

	it('Pause Deposit Withdraw Fails', async () => {
		try {
			await admin.pauseSpotMarketDepositWithdraw(0);
			assert(false);
		} catch (e) {
			console.log(e);
		}
	});

	it('Pause Deposit Withdraw Succeeds', async () => {
		const spotMarket = await admin.getSpotMarketAccount(0);
		const burnIx = createBurnInstruction(
			spotMarket.vault,
			usdcMint.publicKey,
			admin.wallet.publicKey,
			usdcAmount.toNumber(),
			[admin.wallet.payer],
			TOKEN_2022_PROGRAM_ID
		);
		const tx = await admin.buildTransaction([burnIx]);
		// @ts-ignore
		await admin.sendTransaction(tx);

		await admin.pauseSpotMarketDepositWithdraw(0);

		await admin.fetchAccounts();
		const spotMarketAfter = await admin.getSpotMarketAccount(0);
		const pausedOperations = spotMarketAfter.pausedOperations;
		assert(
			pausedOperations === (SpotOperation.DEPOSIT | SpotOperation.WITHDRAW)
		);
	});
});
