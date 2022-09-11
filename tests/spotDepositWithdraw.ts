import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	ClearingHouse,
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
import { QUOTE_PRECISION, ZERO, ONE } from '../sdk';

describe('spot deposit and withdraw', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let admin: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let solOracle: PublicKey;

	let usdcMint;

	let firstUserClearingHouse: ClearingHouse;
	let firstUserClearingHouseUSDCAccount: PublicKey;

	let secondUserClearingHouse: ClearingHouse;
	let secondUserClearingHouseWSOLAccount: PublicKey;
	let secondUserClearingHouseUSDCAccount: PublicKey;

	const usdcAmount = new BN(10 * 10 ** 6);
	const solAmount = new BN(1 * 10 ** 9);

	let marketIndexes: BN[];
	let spotMarketIndexes: BN[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solOracle = await mockOracle(30);

		marketIndexes = [];
		spotMarketIndexes = [new BN(0), new BN(1)];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
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
		await firstUserClearingHouse.unsubscribe();
		await secondUserClearingHouse.unsubscribe();
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
			new BN(0),
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(0);
		assert(spotMarket.marketIndex.eq(new BN(0)));
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

		assert(admin.getStateAccount().numberOfSpotMarkets.eq(new BN(1)));
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
			new BN(1),
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const spotMarket = await admin.getSpotMarketAccount(1);
		assert(spotMarket.marketIndex.eq(new BN(1)));
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

		assert(admin.getStateAccount().numberOfSpotMarkets.eq(new BN(2)));
	});

	it('First User Deposit USDC', async () => {
		[firstUserClearingHouse, firstUserClearingHouseUSDCAccount] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos
			);

		const marketIndex = new BN(0);
		const txSig = await firstUserClearingHouse.deposit(
			usdcAmount,
			marketIndex,
			firstUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(spotMarket.depositBalance.eq(usdcAmount));

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
		const spotPosition =
			firstUserClearingHouse.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.balance.eq(expectedBalance));
	});

	it('Second User Deposit SOL', async () => {
		[
			secondUserClearingHouse,
			secondUserClearingHouseWSOLAccount,
			secondUserClearingHouseUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			ZERO,
			marketIndexes,
			spotMarketIndexes,
			oracleInfos
		);

		const marketIndex = new BN(1);
		const txSig = await secondUserClearingHouse.deposit(
			solAmount,
			marketIndex,
			secondUserClearingHouseWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		assert(spotMarket.depositBalance.eq(SPOT_MARKET_RATE_PRECISION));

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
			secondUserClearingHouse.getUserAccount().spotPositions[1];
		assert(isVariant(spotPosition.balanceType, 'deposit'));
		assert(spotPosition.balance.eq(expectedBalance));
	});

	it('Second User Withdraw First half USDC', async () => {
		const marketIndex = new BN(0);
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await admin.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(5000001);
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
			secondUserClearingHouse.getUserAccount().spotPositions[0];
		assert(isVariant(spotPosition.balanceType, 'borrow'));
		assert(spotPosition.balance.eq(expectedBalance));

		const actualAmountWithdrawn = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					secondUserClearingHouseUSDCAccount
				)
			).value.amount
		);

		assert(withdrawAmount.eq(actualAmountWithdrawn));
	});

	it('Update Cumulative Interest with 50% utilization', async () => {
		const usdcmarketIndex = new BN(0);
		const oldSpotMarketAccount =
			firstUserClearingHouse.getSpotMarketAccount(usdcmarketIndex);

		await sleep(5000);

		const txSig =
			await firstUserClearingHouse.updateSpotMarketCumulativeInterest(
				usdcmarketIndex
			);
		await printTxLogs(connection, txSig);

		await firstUserClearingHouse.fetchAccounts();
		const newSpotMarketAccount =
			firstUserClearingHouse.getSpotMarketAccount(usdcmarketIndex);

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
		const marketIndex = new BN(0);
		let spotMarketAccount =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
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
					secondUserClearingHouseUSDCAccount
				)
			).value.amount
		);

		const spotPositionBefore =
			secondUserClearingHouse.getSpotPosition(marketIndex).balance;

		const withdrawAmount = spotMarketDepositTokenAmountBefore
			.sub(spotMarketBorrowTokenAmountBefore)
			.sub(ONE);

		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		spotMarketAccount =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
		const increaseInspotPosition = getBalance(
			withdrawAmount,
			spotMarketAccount,
			SpotBalanceType.BORROW
		);
		const expectedspotPosition = spotPositionBefore.add(increaseInspotPosition);
		console.log('withdrawAmount:', withdrawAmount.toString());

		assert(
			secondUserClearingHouse
				.getSpotPosition(marketIndex)
				.balance.eq(expectedspotPosition)
		);

		const expectedUserUSDCAmount = userUSDCAmountBefore.add(withdrawAmount);
		const userUSDCAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					secondUserClearingHouseUSDCAccount
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
		const usdcmarketIndex = new BN(0);
		const oldSpotMarketAccount =
			firstUserClearingHouse.getSpotMarketAccount(usdcmarketIndex);

		await sleep(5000);

		const txSig =
			await firstUserClearingHouse.updateSpotMarketCumulativeInterest(
				usdcmarketIndex
			);
		await printTxLogs(connection, txSig);

		await firstUserClearingHouse.fetchAccounts();
		const newSpotMarketAccount =
			firstUserClearingHouse.getSpotMarketAccount(usdcmarketIndex);

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
		const marketIndex = new BN(0);
		const mintAmount = new BN(2 * 10 ** 6); // $2
		const userUSDCAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseUSDCAccount
		);
		await mintUSDCToUser(
			usdcMint,
			secondUserClearingHouseUSDCAccount,
			mintAmount,
			provider
		);

		const userBorrowBalanceBefore =
			secondUserClearingHouse.getSpotPosition(marketIndex).balance;
		const spotMarketDepositBalanceBefore =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.add(mintAmount.div(new BN(2)));
		const txSig = await secondUserClearingHouse.deposit(
			depositAmount,
			marketIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		await secondUserClearingHouse.fetchAccounts();
		const spotMarketAccount =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
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
			secondUserClearingHouse.getSpotPosition(marketIndex);

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
		const marketIndex = new BN(0);

		const spotMarketAccountBefore =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
		const userDepositBalanceBefore =
			secondUserClearingHouse.getSpotPosition(marketIndex).balance;
		const spotMarketDepositBalanceBefore =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex).depositBalance;
		const userDepositokenAmountBefore = getTokenAmount(
			userDepositBalanceBefore,
			spotMarketAccountBefore,
			SpotBalanceType.DEPOSIT
		);

		const borrowAmount = userDepositokenAmountBefore.add(new BN(1 * 10 ** 6));
		const txSig = await secondUserClearingHouse.withdraw(
			borrowAmount,
			marketIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		await secondUserClearingHouse.fetchAccounts();
		const spotMarketAccount =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
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
			secondUserClearingHouse.getSpotPosition(marketIndex);

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
		const marketIndex = new BN(0);
		const userUSDCAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseUSDCAccount
		);
		const currentUserBorrowBalance =
			secondUserClearingHouse.getSpotPosition(marketIndex).balance;
		const spotMarketDepositBalanceBefore =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.mul(new BN(100000)); // huge number
		const txSig = await secondUserClearingHouse.deposit(
			depositAmount,
			marketIndex,
			secondUserClearingHouseUSDCAccount,
			undefined,
			true
		);
		await printTxLogs(connection, txSig);

		const spotMarketAccountAfter =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
		const borrowToPayBack = getTokenAmount(
			currentUserBorrowBalance,
			spotMarketAccountAfter,
			SpotBalanceType.BORROW
		);

		const userUSDCAmountAfter = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseUSDCAccount
		);
		const expectedUserUSDCAmount = userUSDCAmountBefore.sub(borrowToPayBack);
		assert(expectedUserUSDCAmount.eq(userUSDCAmountAfter));

		const userBalanceAfter =
			secondUserClearingHouse.getSpotPosition(marketIndex);
		assert(userBalanceAfter.balance.eq(ZERO));

		assert(spotMarketAccountAfter.borrowBalance.eq(ZERO));
		assert(
			spotMarketAccountAfter.depositBalance.eq(spotMarketDepositBalanceBefore)
		);
	});

	it('Second user reduce only withdraw deposit', async () => {
		const marketIndex = new BN(1);
		const userWSOLAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseWSOLAccount
		);

		const currentUserDepositBalance =
			secondUserClearingHouse.getSpotPosition(marketIndex).balance;

		const withdrawAmount = new BN(LAMPORTS_PER_SOL * 100);
		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserClearingHouseWSOLAccount,
			true
		);
		await printTxLogs(connection, txSig);

		const spotMarketAccountAfter =
			secondUserClearingHouse.getSpotMarketAccount(marketIndex);
		const amountAbleToWithdraw = getTokenAmount(
			currentUserDepositBalance,
			spotMarketAccountAfter,
			SpotBalanceType.DEPOSIT
		);

		const userWSOLAmountAfter = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseWSOLAccount
		);
		const expectedUserWSOLAmount =
			amountAbleToWithdraw.sub(userWSOLAmountBefore);
		console.log(expectedUserWSOLAmount.toString());
		console.log(userWSOLAmountAfter.toString());
		assert(expectedUserWSOLAmount.eq(userWSOLAmountAfter));

		const userBalanceAfter =
			secondUserClearingHouse.getSpotPosition(marketIndex);
		assert(userBalanceAfter.balance.eq(ZERO));
	});
});
