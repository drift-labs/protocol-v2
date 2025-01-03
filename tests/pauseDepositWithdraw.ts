import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

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
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { getBalance } from '../sdk/src/math/spotBalance';
import {
	createBurnInstruction,
	TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SpotOperation,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('spot deposit and withdraw 22', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserDriftClient: TestClient;
	let firstUserDriftClientUSDCAccount: PublicKey;

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
			new BN(10 ** 10).mul(QUOTE_PRECISION)
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
		[firstUserDriftClient, firstUserDriftClientUSDCAccount] =
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

		const marketIndex = 0;
		await sleep(100);
		await firstUserDriftClient.fetchAccounts();
		const txSig = await firstUserDriftClient.deposit(
			usdcAmount,
			marketIndex,
			firstUserDriftClientUSDCAccount
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
		const spotPosition = firstUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(firstUserDriftClient.getUserAccount().totalDeposits.eq(usdcAmount));
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
