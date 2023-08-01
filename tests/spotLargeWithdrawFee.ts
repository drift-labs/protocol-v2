import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	EventSubscriber,
	SPOT_MARKET_RATE_PRECISION,
	isVariant,
	OracleSource,
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	OracleInfo,
	QUOTE_PRECISION,
	BulkAccountLoader,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';

describe('large Spot Withdraw Fee', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let admin: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserDriftClient: TestClient;
	let firstUserDriftClientUSDCAccount: PublicKey;

	const largeUsdcAmount = new BN(10_000_001 * 10 ** 6); // $1 past limit

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, provider);

		solOracle = await mockOracle(30);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
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
		// await secondUserDriftClient.unsubscribe();
		// await thirdUserDriftClient.unsubscribe();
	});

	it('Initialize USDC Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
			new BN(2)
		).toNumber(); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(500)).toNumber(); // 50000% APR
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
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(0);
		assert(spotMarket.marketIndex === 0);
		assert(spotMarket.optimalUtilization === optimalUtilization);
		assert(spotMarket.optimalBorrowRate === optimalRate);
		assert(spotMarket.maxBorrowRate === maxRate);
		assert(spotMarket.decimals === 6);
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
				provider,
				usdcMint,
				chProgram,
				largeUsdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		const marketIndex = 0;
		await sleep(100);
		await firstUserDriftClient.fetchAccounts();
		const txSig = await firstUserDriftClient.deposit(
			largeUsdcAmount,
			marketIndex,
			firstUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		console.log(
			'spotMarket.depositBalance:',
			spotMarket.depositBalance.toString()
		);
		assert(spotMarket.depositBalance.eq(new BN('10000001000000000')));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
		);
		assert(vaultAmount.eq(largeUsdcAmount));

		// const expectedBalance = getBalance(
		// 	largeUsdcAmount,
		// 	spotMarket,
		// 	SpotBalanceType.DEPOSIT
		// );
		const spotPosition = firstUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		// assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			firstUserDriftClient.getUserAccount().totalDeposits.eq(largeUsdcAmount)
		);

		const txSigAfter = await firstUserDriftClient.withdraw(
			largeUsdcAmount,
			marketIndex,
			firstUserDriftClientUSDCAccount,
			true
		);
		await printTxLogs(connection, txSigAfter);

		assert(
			firstUserDriftClient.getUserAccount().totalWithdraws.eq(largeUsdcAmount)
		);

		// now charge me fees

		const txSigDepForFee = await firstUserDriftClient.deposit(
			QUOTE_PRECISION,
			marketIndex,
			firstUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSigDepForFee);

		const txSigWithdrawForFee = await firstUserDriftClient.withdraw(
			QUOTE_PRECISION,
			marketIndex,
			firstUserDriftClientUSDCAccount,
			true
		);
		await printTxLogs(connection, txSigWithdrawForFee);

		const expectedFee = 500;

		console.log(
			firstUserDriftClient.getUserAccount().totalWithdraws.toString()
		);
		assert(
			firstUserDriftClient
				.getUserAccount()
				.totalWithdraws.eq(
					largeUsdcAmount.add(QUOTE_PRECISION.sub(new BN(expectedFee)))
				)
		);

		const vaultAmount2 = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
		);
		assert(vaultAmount2.eq(new BN(expectedFee)));
	});
});
