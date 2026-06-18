import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

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
	mintUSDCToUser,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
	getMaxWithdrawGuardThreshold,
} from './testHelpers';
import {
	getBalance,
	calculateInterestAccumulated,
	getTokenAmount,
} from '../sdk/src/math/spotBalance';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
	QUOTE_PRECISION,
	ZERO,
	ONE,
	SPOT_MARKET_BALANCE_PRECISION,
	PRICE_PRECISION,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

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

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientWSOLAccount: PublicKey;
	let secondUserVelocityClientUSDCAccount: PublicKey;

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

		usdcMint = await mockUSDCMint(bankrunContextWrapper, TOKEN_2022_PROGRAM_ID);
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

		const marketIndex = 1;
		const txSig = await secondUserVelocityClient.deposit(
			solAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(spotMarket.depositBalance.eq(SPOT_MARKET_BALANCE_PRECISION));
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
			secondUserVelocityClient.getUserAccount().spotPositions[1];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		assert(
			secondUserVelocityClient
				.getUserAccount()
				.totalDeposits.eq(new BN(30).mul(PRICE_PRECISION))
		);
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

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(5000000001);
		assert(spotMarket.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
			).amount.toString()
		);
		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const spotPosition =
			secondUserVelocityClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'borrow'));
		assert(spotPosition.scaledBalance.eq(expectedBalance));

		const actualAmountWithdrawn = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount.toString()
		);

		assert(withdrawAmount.eq(actualAmountWithdrawn));

		assert(
			secondUserVelocityClient
				.getUserAccount()
				.totalWithdraws.eq(withdrawAmount)
		);
	});

	it('Update Cumulative Interest with 50% utilization', async () => {
		const usdcmarketIndex = 0;
		const oldSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		await bulkAccountLoader.load();

		const txSig =
			await firstUserVelocityClient.updateSpotMarketCumulativeInterest(
				usdcmarketIndex
			);
		bankrunContextWrapper.printTxLogs(txSig);

		await firstUserVelocityClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		const expectedInterestAccumulated = calculateInterestAccumulated(
			oldSpotMarketAccount,
			newSpotMarketAccount.lastInterestTs
		);
		const expectedCumulativeDepositInterest =
			oldSpotMarketAccount.cumulativeDepositInterest.add(
				expectedInterestAccumulated.depositInterest
			);
		const expectedCumulativeBorrowInterest =
			oldSpotMarketAccount.cumulativeBorrowInterest.add(
				expectedInterestAccumulated.borrowInterest
			);

		assert(
			newSpotMarketAccount.cumulativeDepositInterest.eq(
				expectedCumulativeDepositInterest
			)
		);
		assert(
			newSpotMarketAccount.cumulativeBorrowInterest.eq(
				expectedCumulativeBorrowInterest
			)
		);
	});

	it('Second User Withdraw second half USDC', async () => {
		const marketIndex = 0;
		let spotMarketAccount =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const spotMarketDepositTokenAmountBefore = getTokenAmount(
			spotMarketAccount.depositBalance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);
		const spotMarketBorrowTokenAmountBefore = getTokenAmount(
			spotMarketAccount.borrowBalance,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);
		const spotMarketBorrowBalanceBefore = spotMarketAccount.borrowBalance;

		const userUSDCAmountBefore = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount.toString()
		);

		const spotPositionBefore =
			secondUserVelocityClient.getSpotPosition(marketIndex).scaledBalance;

		const withdrawAmount = spotMarketDepositTokenAmountBefore
			.sub(spotMarketBorrowTokenAmountBefore)
			.sub(ONE);

		const txSig = await secondUserVelocityClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		spotMarketAccount =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const increaseInspotPosition = getBalance(
			withdrawAmount,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);
		const expectedspotPosition = spotPositionBefore.add(increaseInspotPosition);
		console.log('withdrawAmount:', withdrawAmount.toString());

		assert(
			secondUserVelocityClient
				.getSpotPosition(marketIndex)
				.scaledBalance.eq(expectedspotPosition)
		);

		const expectedUserUSDCAmount = userUSDCAmountBefore.add(withdrawAmount);
		const userUSDCAmountAfter = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount.toString()
		);

		assert(expectedUserUSDCAmount.eq(userUSDCAmountAfter));
		assert(
			secondUserVelocityClient
				.getUserAccount()
				.totalWithdraws.eq(userUSDCAmountAfter)
		);

		const expectedSpotMarketBorrowBalance = spotMarketBorrowBalanceBefore.add(
			increaseInspotPosition
		);
		console.assert(
			spotMarketAccount.borrowBalance.eq(expectedSpotMarketBorrowBalance)
		);

		const expectedVaultBalance = usdcAmount.sub(expectedUserUSDCAmount);
		const vaultUSDCAmountAfter = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarketAccount.vault
				)
			).amount.toString()
		);

		assert(expectedVaultBalance.eq(vaultUSDCAmountAfter));

		const spotMarketDepositTokenAmountAfter = getTokenAmount(
			spotMarketAccount.depositBalance,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);
		const spotMarketBorrowTokenAmountAfter = getTokenAmount(
			spotMarketAccount.borrowBalance,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);

		// TODO
		console.log(
			spotMarketDepositTokenAmountAfter.toString(),
			spotMarketBorrowTokenAmountAfter.toString()
		);
		assert(
			spotMarketDepositTokenAmountAfter
				.sub(spotMarketBorrowTokenAmountAfter)
				.lte(ONE)
		);
	});

	it('Update Cumulative Interest with 100% utilization', async () => {
		const usdcmarketIndex = 0;
		const oldSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		await bulkAccountLoader.load();

		const txSig =
			await firstUserVelocityClient.updateSpotMarketCumulativeInterest(
				usdcmarketIndex
			);
		bankrunContextWrapper.printTxLogs(txSig);

		await firstUserVelocityClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserVelocityClient.getSpotMarketAccount(usdcmarketIndex);

		const expectedInterestAccumulated = calculateInterestAccumulated(
			oldSpotMarketAccount,
			newSpotMarketAccount.lastInterestTs
		);
		const expectedCumulativeDepositInterest =
			oldSpotMarketAccount.cumulativeDepositInterest.add(
				expectedInterestAccumulated.depositInterest
			);
		const expectedCumulativeBorrowInterest =
			oldSpotMarketAccount.cumulativeBorrowInterest.add(
				expectedInterestAccumulated.borrowInterest
			);

		assert(
			newSpotMarketAccount.cumulativeDepositInterest.eq(
				expectedCumulativeDepositInterest
			)
		);
		console.log(
			newSpotMarketAccount.cumulativeBorrowInterest.sub(ONE).toString(),
			expectedCumulativeBorrowInterest.toString()
		);

		// inconcistent time leads to slight differences over runs?
		assert(
			newSpotMarketAccount.cumulativeBorrowInterest
				.sub(ONE)
				.eq(expectedCumulativeBorrowInterest) ||
				newSpotMarketAccount.cumulativeBorrowInterest.eq(
					expectedCumulativeBorrowInterest
				)
		);
	});

	it('Flip second user borrow to deposit', async () => {
		const marketIndex = 0;
		const mintAmount = new BN(2 * 10 ** 6); // $2
		const userUSDCAmountBefore = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount.toString()
		);

		await mintUSDCToUser(
			usdcMint,
			secondUserVelocityClientUSDCAccount,
			mintAmount,
			bankrunContextWrapper
		);

		const userBorrowBalanceBefore =
			secondUserVelocityClient.getSpotPosition(marketIndex).scaledBalance;
		const spotMarketDepositBalanceBefore =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.add(mintAmount.div(new BN(2)));
		const txSig = await secondUserVelocityClient.deposit(
			depositAmount,
			marketIndex,
			secondUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await secondUserVelocityClient.fetchAccounts();
		const spotMarketAccount =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const borrowToPayOff = getTokenAmount(
			userBorrowBalanceBefore,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);
		const newDepositTokenAmount = depositAmount.sub(borrowToPayOff);

		const expectedUserBalance = getBalance(
			newDepositTokenAmount,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);
		const userBalanceAfter =
			secondUserVelocityClient.getSpotPosition(marketIndex);

		console.log(
			expectedUserBalance.toString(),
			userBalanceAfter.scaledBalance.toString()
		);

		assert(expectedUserBalance.eq(userBalanceAfter.scaledBalance));
		assert(isVariant(userBalanceAfter.balanceType, 'deposit'));

		const expectedSpotMarketDepositBalance =
			spotMarketDepositBalanceBefore.add(expectedUserBalance);

		console.log(
			spotMarketAccount.depositBalance.toString(),
			expectedSpotMarketDepositBalance.toString()
		);

		assert(
			spotMarketAccount.depositBalance.eq(expectedSpotMarketDepositBalance)
		);
		assert(spotMarketAccount.borrowBalance.eq(ZERO));
	});

	it('Flip second user deposit to borrow', async () => {
		const marketIndex = 0;

		const spotMarketAccountBefore =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const userDepositBalanceBefore =
			secondUserVelocityClient.getSpotPosition(marketIndex).scaledBalance;
		const spotMarketDepositBalanceBefore =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex).depositBalance;
		const userDepositokenAmountBefore = getTokenAmount(
			userDepositBalanceBefore,
			spotMarketAccountBefore,
			SpotBalanceType.DEPOSIT
		);

		const borrowAmount = userDepositokenAmountBefore.add(new BN(1 * 10 ** 6));
		const txSig = await secondUserVelocityClient.withdraw(
			borrowAmount,
			marketIndex,
			secondUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await secondUserVelocityClient.fetchAccounts();
		const spotMarketAccount =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const depositToWithdrawAgainst = getTokenAmount(
			userDepositBalanceBefore,
			spotMarketAccount,
			SpotBalanceType.DEPOSIT
		);
		const newBorrowTokenAmount = borrowAmount.sub(depositToWithdrawAgainst);

		const expectedUserBalance = getBalance(
			newBorrowTokenAmount,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);
		const userBalanceAfter =
			secondUserVelocityClient.getSpotPosition(marketIndex);

		assert(expectedUserBalance.eq(userBalanceAfter.scaledBalance));
		assert(isVariant(userBalanceAfter.balanceType, 'borrow'));

		const expectedSpotMarketDepositBalance = spotMarketDepositBalanceBefore.sub(
			userDepositBalanceBefore
		);
		assert(
			spotMarketAccount.depositBalance.eq(expectedSpotMarketDepositBalance)
		);
		assert(spotMarketAccount.borrowBalance.eq(expectedUserBalance));
	});

	it('Second user reduce only pay down borrow', async () => {
		const marketIndex = 0;
		const userUSDCAmountBefore = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount.toString()
		);

		const currentUserBorrowBalance =
			secondUserVelocityClient.getSpotPosition(marketIndex).scaledBalance;
		const spotMarketDepositBalanceBefore =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.mul(new BN(100000)); // huge number
		const txSig = await secondUserVelocityClient.deposit(
			depositAmount,
			marketIndex,
			secondUserVelocityClientUSDCAccount,
			undefined,
			true
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarketAccountAfter =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const borrowToPayBack = getTokenAmount(
			currentUserBorrowBalance,
			spotMarketAccountAfter,
			SpotBalanceType.BORROW
		);

		const userUSDCAmountAfter = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount.toString()
		);

		const expectedUserUSDCAmount = userUSDCAmountBefore.sub(borrowToPayBack);
		console.log(
			expectedUserUSDCAmount.toString(),
			userUSDCAmountAfter.toString()
		);
		assert(expectedUserUSDCAmount.eq(userUSDCAmountAfter));

		const userBalanceAfter =
			secondUserVelocityClient.getSpotPosition(marketIndex);
		assert(userBalanceAfter.scaledBalance.eq(ZERO));

		assert(spotMarketAccountAfter.borrowBalance.eq(ZERO));
		assert(
			spotMarketAccountAfter.depositBalance.eq(spotMarketDepositBalanceBefore)
		);
	});

	it('Second user reduce only withdraw deposit', async () => {
		const marketIndex = 1;
		const userWSOLAmountBefore = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientWSOLAccount
				)
			).amount.toString()
		);

		const currentUserDepositBalance =
			secondUserVelocityClient.getSpotPosition(marketIndex).scaledBalance;

		const withdrawAmount = new BN(LAMPORTS_PER_SOL * 100);
		const txSig = await secondUserVelocityClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount,
			true
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotMarketAccountAfter =
			secondUserVelocityClient.getSpotMarketAccount(marketIndex);
		const amountAbleToWithdraw = getTokenAmount(
			currentUserDepositBalance,
			spotMarketAccountAfter,
			SpotBalanceType.DEPOSIT
		);

		const userWSOLAmountAfter = new BN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientWSOLAccount
				)
			).amount.toString()
		);

		const expectedUserWSOLAmount =
			amountAbleToWithdraw.sub(userWSOLAmountBefore);
		console.log(expectedUserWSOLAmount.toString());
		console.log(userWSOLAmountAfter.toString());
		assert(expectedUserWSOLAmount.eq(userWSOLAmountAfter));

		const userBalanceAfter =
			secondUserVelocityClient.getSpotPosition(marketIndex);
		assert(userBalanceAfter.scaledBalance.eq(ZERO));
	});

	it('Third user deposits when cumulative interest off init value', async () => {
		// rounding on spot market balance <-> token conversions can lead to tiny epislon of loss on deposits

		const [
			thirdUserVelocityClient,
			_thirdUserVelocityClientWSOLAccount,
			thirdUserVelocityClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			solAmount,
			largeUsdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos,
			bulkAccountLoader
		);

		const marketIndex = 0;

		await thirdUserVelocityClient.fetchAccounts();
		const spotPosition = thirdUserVelocityClient.getSpotPosition(marketIndex);
		console.log(spotPosition);
		assert(spotPosition.scaledBalance.eq(ZERO));

		const spotMarket =
			thirdUserVelocityClient.getSpotMarketAccount(marketIndex);

		console.log(spotMarket.cumulativeDepositInterest.toString());
		console.log(spotMarket.cumulativeBorrowInterest.toString());

		assert(
			spotMarket.cumulativeDepositInterest.gt(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);
		assert(
			spotMarket.cumulativeBorrowInterest.gt(
				SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION
			)
		);

		console.log('usdcAmount:', largeUsdcAmount.toString(), 'user deposits');
		const txSig = await thirdUserVelocityClient.deposit(
			largeUsdcAmount,
			marketIndex,
			thirdUserVelocityClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		const spotPositionAfter =
			thirdUserVelocityClient.getSpotPosition(marketIndex);
		const tokenAmount = getTokenAmount(
			spotPositionAfter.scaledBalance,
			spotMarket,
			spotPositionAfter.balanceType
		);
		console.log('tokenAmount:', tokenAmount.toString());
		assert(
			tokenAmount.gte(largeUsdcAmount.sub(QUOTE_PRECISION.div(new BN(100))))
		); // didnt lose more than a penny
		assert(tokenAmount.lt(largeUsdcAmount)); // lose a lil bit

		await thirdUserVelocityClient.unsubscribe();
	});
});
