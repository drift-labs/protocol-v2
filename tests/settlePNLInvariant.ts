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
	createUserWithUSDCAndWSOLAccount,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { getBalance } from '../sdk/src/math/spotBalance';
import { NATIVE_MINT } from '@solana/spl-token';
import {
	QUOTE_PRECISION,
	ZERO,
	SPOT_MARKET_BALANCE_PRECISION,
	PRICE_PRECISION,
	PositionDirection,
	BASE_PRECISION,
	PEG_PRECISION,
} from '../sdk';
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
	let firstUserDriftClientUSDCAccount: PublicKey;

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;

	const usdcAmount = new BN(10 * 10 ** 6);
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

		marketIndexes = [0];
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
		const spotMarket = await admin.getSpotMarketAccount(1);
		assert(spotMarket.marketIndex === 1);
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

		console.log(spotMarket.historicalOracleData);
		assert(spotMarket.historicalOracleData.lastOraclePriceTwapTs.eq(ZERO));

		assert(
			spotMarket.historicalOracleData.lastOraclePrice.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap5Min.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);

		assert(admin.getStateAccount().numberOfSpotMarkets === 2);
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

	it('Second User Deposit SOL', async () => {
		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
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

		const marketIndex = 1;
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(spotMarket.depositBalance.eq(SPOT_MARKET_BALANCE_PRECISION));
		console.log(spotMarket.historicalOracleData);
		assert(spotMarket.historicalOracleData.lastOraclePriceTwapTs.gt(ZERO));
		assert(
			spotMarket.historicalOracleData.lastOraclePrice.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);
		assert(
			spotMarket.historicalOracleData.lastOraclePriceTwap5Min.eq(
				new BN(30 * PRICE_PRECISION.toNumber())
			)
		);

		const vaultAmount = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
			).amount.toString()
		);
		assert(vaultAmount.eq(solAmount));

		const expectedBalance = getBalance(
			solAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const spotPosition =
			secondUserDriftClient.getUserAccount().spotPositions[1];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			secondUserDriftClient
				.getUserAccount()
				.totalDeposits.eq(new BN(30).mul(PRICE_PRECISION))
		);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR
		const mantissaSqrtScale = new BN(100000);
		const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
			mantissaSqrtScale
		);
		await admin.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(30).mul(PEG_PRECISION)
		);

		await admin.updatePerpAuctionDuration(new BN(0));
	});

	it('Trade and settle pnl', async () => {
		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		await secondUserDriftClient.openPosition(
			PositionDirection.LONG,
			baseAssetAmount,
			marketIndex
		);

		await secondUserDriftClient.settlePNL(
			await secondUserDriftClient.getUserAccountPublicKey(),
			secondUserDriftClient.getUserAccount(),
			marketIndex
		);

		await secondUserDriftClient.fetchAccounts();

		const quoteTokenAmount = await secondUserDriftClient.getTokenAmount(0);

		assert(quoteTokenAmount.eq(new BN(-30003)));

		const settlePnlRecord = eventSubscriber.getEventsArray('SettlePnlRecord');
		assert(settlePnlRecord.length === 1);
		assert(settlePnlRecord[0].pnl.eq(new BN(-30002)));
	});
});
