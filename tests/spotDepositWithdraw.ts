import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import {
	AdminClient,
	BN,
	DriftClient,
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
	getTokenAmountAsBN,
	mintUSDCToUser,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';
import {
	getBalance,
	calculateInterestAccumulated,
	getTokenAmount,
} from '../sdk/src/math/spotBalance';
import { NATIVE_MINT } from '@solana/spl-token';
import {
	QUOTE_PRECISION,
	ZERO,
	ONE,
	SPOT_MARKET_BALANCE_PRECISION,
} from '../sdk';

describe('spot deposit and withdraw', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	let admin: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, driftProgram);
	eventSubscriber.subscribe();

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserDriftClient: DriftClient;
	let firstUserDriftClientUSDCAccount: PublicKey;

	let secondUserDriftClient: DriftClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;

	const usdcAmount = new BN(10 * 10 ** 6);
	const largeUsdcAmount = new BN(10_000 * 10 ** 6);

	const solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, largeUsdcAmount, provider);

		solOracle = await mockOracle(30);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
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
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(new BN(2)); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)); // 5000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION;
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION;
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION;
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION;
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
		assert(spotMarket.optimalUtilization.eq(optimalUtilization));
		assert(spotMarket.optimalBorrowRate.eq(optimalRate));
		assert(spotMarket.maxBorrowRate.eq(maxRate));
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
		assert(spotMarket.initialAssetWeight.eq(initialAssetWeight));
		assert(spotMarket.maintenanceAssetWeight.eq(maintenanceAssetWeight));
		assert(spotMarket.initialLiabilityWeight.eq(initialLiabilityWeight));
		assert(spotMarket.maintenanceAssetWeight.eq(maintenanceAssetWeight));

		assert(admin.getStateAccount().numberOfSpotMarkets === 1);
	});

	it('Initialize SOL Market', async () => {
		const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(new BN(2)); // 50% utilization
		const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)); // 2000% APR
		const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)); // 5000% APR
		const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(8)).div(
			new BN(10)
		);
		const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
			new BN(9)
		).div(new BN(10));
		const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
			new BN(12)
		).div(new BN(10));
		const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
			new BN(11)
		).div(new BN(10));

		await admin.initializeSpotMarket(
			NATIVE_MINT,
			optimalUtilization,
			optimalRate,
			maxRate,
			solOracle,
			OracleSource.QUOTE_ASSET,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);

		const txSig = await admin.updateWithdrawGuardThreshold(
			1,
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(1);
		assert(spotMarket.marketIndex === 1);
		assert(spotMarket.optimalUtilization.eq(optimalUtilization));
		assert(spotMarket.optimalBorrowRate.eq(optimalRate));
		assert(spotMarket.maxBorrowRate.eq(maxRate));
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
		assert(spotMarket.initialAssetWeight.eq(initialAssetWeight));
		assert(spotMarket.maintenanceAssetWeight.eq(maintenanceAssetWeight));
		assert(spotMarket.initialLiabilityWeight.eq(initialLiabilityWeight));
		assert(spotMarket.maintenanceAssetWeight.eq(maintenanceAssetWeight));

		assert(admin.getStateAccount().numberOfSpotMarkets === 2);
	});

	it('First User Deposit USDC', async () => {
		[firstUserDriftClient, firstUserDriftClientUSDCAccount] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				driftProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos
			);

		const marketIndex = 0;
		const txSig = await firstUserDriftClient.deposit(
			usdcAmount,
			marketIndex,
			firstUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(
			spotMarket.depositBalance.eq(
				new BN(10 * SPOT_MARKET_BALANCE_PRECISION.toNumber())
			)
		);

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
		);
		assert(vaultAmount.eq(usdcAmount));

		const expectedBalance = getBalance(
			usdcAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const spotPosition = firstUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.balance.eq(expectedBalance));
	});

	it('Second User Deposit SOL', async () => {
		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			driftProgram,
			solAmount,
			ZERO,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos
		);

		const marketIndex = 1;
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(spotMarket.depositBalance.eq(SPOT_MARKET_BALANCE_PRECISION));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
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
		assert(spotPosition.balance.eq(expectedBalance));
	});

	it('Second User Withdraw First half USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(5000000001);
		assert(spotMarket.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
		);
		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const spotPosition =
			secondUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'borrow'));
		assert(spotPosition.balance.eq(expectedBalance));

		const actualAmountWithdrawn = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					secondUserDriftClientUSDCAccount
				)
			).value.amount
		);

		assert(withdrawAmount.eq(actualAmountWithdrawn));
	});

	it('Update Cumulative Interest with 50% utilization', async () => {
		const usdcmarketIndex = 0;
		const oldSpotMarketAccount =
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

		await sleep(5000);

		const txSig = await firstUserDriftClient.updateSpotMarketCumulativeInterest(
			usdcmarketIndex
		);
		await printTxLogs(connection, txSig);

		await firstUserDriftClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

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
			secondUserDriftClient.getSpotMarketAccount(marketIndex);
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
				await provider.connection.getTokenAccountBalance(
					secondUserDriftClientUSDCAccount
				)
			).value.amount
		);

		const spotPositionBefore =
			secondUserDriftClient.getSpotPosition(marketIndex).balance;

		const withdrawAmount = spotMarketDepositTokenAmountBefore
			.sub(spotMarketBorrowTokenAmountBefore)
			.sub(ONE);

		const txSig = await secondUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		spotMarketAccount = secondUserDriftClient.getSpotMarketAccount(marketIndex);
		const increaseInspotPosition = getBalance(
			withdrawAmount,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);
		const expectedspotPosition = spotPositionBefore.add(increaseInspotPosition);
		console.log('withdrawAmount:', withdrawAmount.toString());

		assert(
			secondUserDriftClient
				.getSpotPosition(marketIndex)
				.balance.eq(expectedspotPosition)
		);

		const expectedUserUSDCAmount = userUSDCAmountBefore.add(withdrawAmount);
		const userUSDCAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					secondUserDriftClientUSDCAccount
				)
			).value.amount
		);
		assert(expectedUserUSDCAmount.eq(userUSDCAmountAfter));

		const expectedSpotMarketBorrowBalance = spotMarketBorrowBalanceBefore.add(
			increaseInspotPosition
		);
		console.assert(
			spotMarketAccount.borrowBalance.eq(expectedSpotMarketBorrowBalance)
		);

		const expectedVaultBalance = usdcAmount.sub(expectedUserUSDCAmount);
		const vaultUSDCAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarketAccount.vault
				)
			).value.amount
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
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

		await sleep(5000);

		const txSig = await firstUserDriftClient.updateSpotMarketCumulativeInterest(
			usdcmarketIndex
		);
		await printTxLogs(connection, txSig);

		await firstUserDriftClient.fetchAccounts();
		const newSpotMarketAccount =
			firstUserDriftClient.getSpotMarketAccount(usdcmarketIndex);

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

	it('Flip second user borrow to deposit', async () => {
		const marketIndex = 0;
		const mintAmount = new BN(2 * 10 ** 6); // $2
		const userUSDCAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserDriftClientUSDCAccount
		);
		await mintUSDCToUser(
			usdcMint,
			secondUserDriftClientUSDCAccount,
			mintAmount,
			provider
		);

		const userBorrowBalanceBefore =
			secondUserDriftClient.getSpotPosition(marketIndex).balance;
		const spotMarketDepositBalanceBefore =
			secondUserDriftClient.getSpotMarketAccount(marketIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.add(mintAmount.div(new BN(2)));
		const txSig = await secondUserDriftClient.deposit(
			depositAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		await secondUserDriftClient.fetchAccounts();
		const spotMarketAccount =
			secondUserDriftClient.getSpotMarketAccount(marketIndex);
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
		const userBalanceAfter = secondUserDriftClient.getSpotPosition(marketIndex);

		assert(expectedUserBalance.eq(userBalanceAfter.balance));
		assert(isVariant(userBalanceAfter.balanceType, 'deposit'));

		const expectedSpotMarketDepositBalance =
			spotMarketDepositBalanceBefore.add(expectedUserBalance);
		assert(
			spotMarketAccount.depositBalance.eq(expectedSpotMarketDepositBalance)
		);
		assert(spotMarketAccount.borrowBalance.eq(ZERO));
	});

	it('Flip second user deposit to borrow', async () => {
		const marketIndex = 0;

		const spotMarketAccountBefore =
			secondUserDriftClient.getSpotMarketAccount(marketIndex);
		const userDepositBalanceBefore =
			secondUserDriftClient.getSpotPosition(marketIndex).balance;
		const spotMarketDepositBalanceBefore =
			secondUserDriftClient.getSpotMarketAccount(marketIndex).depositBalance;
		const userDepositokenAmountBefore = getTokenAmount(
			userDepositBalanceBefore,
			spotMarketAccountBefore,
			SpotBalanceType.DEPOSIT
		);

		const borrowAmount = userDepositokenAmountBefore.add(new BN(1 * 10 ** 6));
		const txSig = await secondUserDriftClient.withdraw(
			borrowAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		await secondUserDriftClient.fetchAccounts();
		const spotMarketAccount =
			secondUserDriftClient.getSpotMarketAccount(marketIndex);
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
		const userBalanceAfter = secondUserDriftClient.getSpotPosition(marketIndex);

		assert(expectedUserBalance.eq(userBalanceAfter.balance));
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
		const userUSDCAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserDriftClientUSDCAccount
		);
		const currentUserBorrowBalance =
			secondUserDriftClient.getSpotPosition(marketIndex).balance;
		const spotMarketDepositBalanceBefore =
			secondUserDriftClient.getSpotMarketAccount(marketIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.mul(new BN(100000)); // huge number
		const txSig = await secondUserDriftClient.deposit(
			depositAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount,
			undefined,
			true
		);
		await printTxLogs(connection, txSig);

		const spotMarketAccountAfter =
			secondUserDriftClient.getSpotMarketAccount(marketIndex);
		const borrowToPayBack = getTokenAmount(
			currentUserBorrowBalance,
			spotMarketAccountAfter,
			SpotBalanceType.BORROW
		);

		const userUSDCAmountAfter = await getTokenAmountAsBN(
			connection,
			secondUserDriftClientUSDCAccount
		);
		const expectedUserUSDCAmount = userUSDCAmountBefore.sub(borrowToPayBack);
		assert(expectedUserUSDCAmount.eq(userUSDCAmountAfter));

		const userBalanceAfter = secondUserDriftClient.getSpotPosition(marketIndex);
		assert(userBalanceAfter.balance.eq(ZERO));

		assert(spotMarketAccountAfter.borrowBalance.eq(ZERO));
		assert(
			spotMarketAccountAfter.depositBalance.eq(spotMarketDepositBalanceBefore)
		);
	});

	it('Second user reduce only withdraw deposit', async () => {
		const marketIndex = 1;
		const userWSOLAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserDriftClientWSOLAccount
		);

		const currentUserDepositBalance =
			secondUserDriftClient.getSpotPosition(marketIndex).balance;

		const withdrawAmount = new BN(LAMPORTS_PER_SOL * 100);
		const txSig = await secondUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount,
			true
		);
		await printTxLogs(connection, txSig);

		const spotMarketAccountAfter =
			secondUserDriftClient.getSpotMarketAccount(marketIndex);
		const amountAbleToWithdraw = getTokenAmount(
			currentUserDepositBalance,
			spotMarketAccountAfter,
			SpotBalanceType.DEPOSIT
		);

		const userWSOLAmountAfter = await getTokenAmountAsBN(
			connection,
			secondUserDriftClientWSOLAccount
		);
		const expectedUserWSOLAmount =
			amountAbleToWithdraw.sub(userWSOLAmountBefore);
		console.log(expectedUserWSOLAmount.toString());
		console.log(userWSOLAmountAfter.toString());
		assert(expectedUserWSOLAmount.eq(userWSOLAmountAfter));

		const userBalanceAfter = secondUserDriftClient.getSpotPosition(marketIndex);
		assert(userBalanceAfter.balance.eq(ZERO));
	});

	it('Third user deposits when cumulative interest off init value', async () => {
		// rounding on bank balance <-> token conversions can lead to tiny epislon of loss on deposits

		const [
			thirdUserDriftClient,
			_thirdUserDriftClientWSOLAccount,
			thirdUserDriftClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			driftProgram,
			solAmount,
			largeUsdcAmount,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos
		);

		const marketIndex = 0;

		const spotPosition = thirdUserDriftClient.getSpotPosition(marketIndex);
		console.log(spotPosition);
		assert(spotPosition.balance.eq(ZERO));

		const spotMarket = thirdUserDriftClient.getSpotMarketAccount(marketIndex);

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
		const txSig = await thirdUserDriftClient.deposit(
			largeUsdcAmount,
			marketIndex,
			thirdUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotPositionAfter = thirdUserDriftClient.getSpotPosition(marketIndex);
		const tokenAmount = getTokenAmount(
			spotPositionAfter.balance,
			spotMarket,
			spotPositionAfter.balanceType
		);
		console.log('tokenAmount:', tokenAmount.toString());
		assert(
			tokenAmount.gte(largeUsdcAmount.sub(QUOTE_PRECISION.div(new BN(100))))
		); // didnt lose more than a penny
		assert(tokenAmount.lt(largeUsdcAmount)); // lose a lil bit

		await thirdUserDriftClient.unsubscribe();
	});
});
