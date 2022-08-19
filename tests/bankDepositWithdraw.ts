import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	ClearingHouse,
	EventSubscriber,
	BANK_RATE_PRECISION,
	BankBalanceType,
	isVariant,
	OracleSource,
	BANK_WEIGHT_PRECISION,
	BANK_CUMULATIVE_INTEREST_PRECISION,
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
} from '../sdk/src/math/bankBalance';
import { NATIVE_MINT } from '@solana/spl-token';
import { QUOTE_PRECISION, ZERO, ONE } from '../sdk';

describe('bank deposit and withdraw', () => {
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
	let bankIndexes: BN[];
	let oracleInfos: OracleInfo[];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solOracle = await mockOracle(30);

		marketIndexes = [];
		bankIndexes = [new BN(0), new BN(1)];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		admin = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes,
			bankIndexes,
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

	it('Initialize USDC Bank', async () => {
		const optimalUtilization = BANK_RATE_PRECISION.div(new BN(2)); // 50% utilization
		const optimalRate = BANK_RATE_PRECISION.mul(new BN(20)); // 2000% APR
		const maxRate = BANK_RATE_PRECISION.mul(new BN(50)); // 5000% APR
		const initialAssetWeight = BANK_WEIGHT_PRECISION;
		const maintenanceAssetWeight = BANK_WEIGHT_PRECISION;
		const initialLiabilityWeight = BANK_WEIGHT_PRECISION;
		const maintenanceLiabilityWeight = BANK_WEIGHT_PRECISION;
		await admin.initializeBank(
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
		const txSig = await admin.updateBankWithdrawGuardThreshold(
			new BN(0),
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const bank = await admin.getBankAccount(0);
		assert(bank.bankIndex.eq(new BN(0)));
		assert(bank.optimalUtilization.eq(optimalUtilization));
		assert(bank.optimalBorrowRate.eq(optimalRate));
		assert(bank.maxBorrowRate.eq(maxRate));
		assert(
			bank.cumulativeBorrowInterest.eq(BANK_CUMULATIVE_INTEREST_PRECISION)
		);
		assert(
			bank.cumulativeDepositInterest.eq(BANK_CUMULATIVE_INTEREST_PRECISION)
		);
		assert(bank.initialAssetWeight.eq(initialAssetWeight));
		assert(bank.maintenanceAssetWeight.eq(maintenanceAssetWeight));
		assert(bank.initialLiabilityWeight.eq(initialLiabilityWeight));
		assert(bank.maintenanceAssetWeight.eq(maintenanceAssetWeight));

		assert(admin.getStateAccount().numberOfBanks.eq(new BN(1)));
	});

	it('Initialize SOL Bank', async () => {
		const optimalUtilization = BANK_RATE_PRECISION.div(new BN(2)); // 50% utilization
		const optimalRate = BANK_RATE_PRECISION.mul(new BN(20)); // 2000% APR
		const maxRate = BANK_RATE_PRECISION.mul(new BN(50)); // 5000% APR
		const initialAssetWeight = BANK_WEIGHT_PRECISION.mul(new BN(8)).div(
			new BN(10)
		);
		const maintenanceAssetWeight = BANK_WEIGHT_PRECISION.mul(new BN(9)).div(
			new BN(10)
		);
		const initialLiabilityWeight = BANK_WEIGHT_PRECISION.mul(new BN(12)).div(
			new BN(10)
		);
		const maintenanceLiabilityWeight = BANK_WEIGHT_PRECISION.mul(
			new BN(11)
		).div(new BN(10));

		await admin.initializeBank(
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

		const txSig = await admin.updateBankWithdrawGuardThreshold(
			new BN(1),
			new BN(10 ** 10).mul(QUOTE_PRECISION)
		);
		await printTxLogs(connection, txSig);
		await admin.fetchAccounts();
		const bank = await admin.getBankAccount(1);
		assert(bank.bankIndex.eq(new BN(1)));
		assert(bank.optimalUtilization.eq(optimalUtilization));
		assert(bank.optimalBorrowRate.eq(optimalRate));
		assert(bank.maxBorrowRate.eq(maxRate));
		assert(
			bank.cumulativeBorrowInterest.eq(BANK_CUMULATIVE_INTEREST_PRECISION)
		);
		assert(
			bank.cumulativeDepositInterest.eq(BANK_CUMULATIVE_INTEREST_PRECISION)
		);
		assert(bank.initialAssetWeight.eq(initialAssetWeight));
		assert(bank.maintenanceAssetWeight.eq(maintenanceAssetWeight));
		assert(bank.initialLiabilityWeight.eq(initialLiabilityWeight));
		assert(bank.maintenanceAssetWeight.eq(maintenanceAssetWeight));

		assert(admin.getStateAccount().numberOfBanks.eq(new BN(2)));
	});

	it('First User Deposit USDC', async () => {
		[firstUserClearingHouse, firstUserClearingHouseUSDCAccount] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				bankIndexes,
				oracleInfos
			);

		const bankIndex = new BN(0);
		const txSig = await firstUserClearingHouse.deposit(
			usdcAmount,
			bankIndex,
			firstUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const bank = await admin.getBankAccount(bankIndex);
		assert(bank.depositBalance.eq(usdcAmount));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(bank.vault)
			).value.amount
		);
		assert(vaultAmount.eq(usdcAmount));

		const expectedBalance = getBalance(
			usdcAmount,
			bank,
			BankBalanceType.DEPOSIT
		);
		const userBankBalance =
			firstUserClearingHouse.getUserAccount().bankBalances[0];
		assert(isVariant(userBankBalance.balanceType, 'deposit'));
		assert(userBankBalance.balance.eq(expectedBalance));
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
			bankIndexes,
			oracleInfos
		);

		const bankIndex = new BN(1);
		const txSig = await secondUserClearingHouse.deposit(
			solAmount,
			bankIndex,
			secondUserClearingHouseWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const bank = await admin.getBankAccount(bankIndex);
		assert(bank.depositBalance.eq(BANK_RATE_PRECISION));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(bank.vault)
			).value.amount
		);
		assert(vaultAmount.eq(solAmount));

		const expectedBalance = getBalance(
			solAmount,
			bank,
			BankBalanceType.DEPOSIT
		);
		const userBankBalance =
			secondUserClearingHouse.getUserAccount().bankBalances[1];
		assert(isVariant(userBankBalance.balanceType, 'deposit'));
		assert(userBankBalance.balance.eq(expectedBalance));
	});

	it('Second User Withdraw First half USDC', async () => {
		const bankIndex = new BN(0);
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			bankIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const bank = await admin.getBankAccount(bankIndex);
		const expectedBorrowBalance = new BN(5000001);
		assert(bank.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(bank.vault)
			).value.amount
		);
		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			bank,
			BankBalanceType.BORROW
		);

		const userBankBalance =
			secondUserClearingHouse.getUserAccount().bankBalances[0];
		assert(isVariant(userBankBalance.balanceType, 'borrow'));
		assert(userBankBalance.balance.eq(expectedBalance));

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
		const usdcBankIndex = new BN(0);
		const oldBankAccount = firstUserClearingHouse.getBankAccount(usdcBankIndex);

		await sleep(5000);

		const txSig = await firstUserClearingHouse.updateBankCumulativeInterest(
			usdcBankIndex
		);
		await printTxLogs(connection, txSig);

		await firstUserClearingHouse.fetchAccounts();
		const newBankAccount = firstUserClearingHouse.getBankAccount(usdcBankIndex);

		const expectedInterestAccumulated = calculateInterestAccumulated(
			oldBankAccount,
			newBankAccount.lastInterestTs
		);
		const expectedCumulativeDepositInterest =
			oldBankAccount.cumulativeDepositInterest.add(
				expectedInterestAccumulated.depositInterest
			);
		const expectedCumulativeBorrowInterest =
			oldBankAccount.cumulativeBorrowInterest.add(
				expectedInterestAccumulated.borrowInterest
			);

		assert(
			newBankAccount.cumulativeDepositInterest.eq(
				expectedCumulativeDepositInterest
			)
		);
		assert(
			newBankAccount.cumulativeBorrowInterest.eq(
				expectedCumulativeBorrowInterest
			)
		);
	});

	it('Second User Withdraw second half USDC', async () => {
		const bankIndex = new BN(0);
		let bankAccount = secondUserClearingHouse.getBankAccount(bankIndex);
		const bankDepositTokenAmountBefore = getTokenAmount(
			bankAccount.depositBalance,
			bankAccount,
			BankBalanceType.DEPOSIT
		);
		const bankBorrowTokenAmountBefore = getTokenAmount(
			bankAccount.borrowBalance,
			bankAccount,
			BankBalanceType.BORROW
		);
		const bankBorrowBalanceBefore = bankAccount.borrowBalance;

		const userUSDCAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					secondUserClearingHouseUSDCAccount
				)
			).value.amount
		);

		const userBankBalanceBefore =
			secondUserClearingHouse.getUserBankBalance(bankIndex).balance;

		const withdrawAmount = bankDepositTokenAmountBefore
			.sub(bankBorrowTokenAmountBefore)
			.sub(ONE);

		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			bankIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		bankAccount = secondUserClearingHouse.getBankAccount(bankIndex);
		const increaseInUserBankBalance = getBalance(
			withdrawAmount,
			bankAccount,
			BankBalanceType.BORROW
		);
		const expectedUserBankBalance = userBankBalanceBefore.add(
			increaseInUserBankBalance
		);
		console.log('withdrawAmount:', withdrawAmount.toString());

		assert(
			secondUserClearingHouse
				.getUserBankBalance(bankIndex)
				.balance.eq(expectedUserBankBalance)
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

		const expectedBankBorrowBalance = bankBorrowBalanceBefore.add(
			increaseInUserBankBalance
		);
		console.assert(bankAccount.borrowBalance.eq(expectedBankBorrowBalance));

		const expectedVaultBalance = usdcAmount.sub(expectedUserUSDCAmount);
		const vaultUSDCAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(bankAccount.vault)
			).value.amount
		);

		assert(expectedVaultBalance.eq(vaultUSDCAmountAfter));

		const bankDepositTokenAmountAfter = getTokenAmount(
			bankAccount.depositBalance,
			bankAccount,
			BankBalanceType.DEPOSIT
		);
		const bankBorrowTokenAmountAfter = getTokenAmount(
			bankAccount.borrowBalance,
			bankAccount,
			BankBalanceType.BORROW
		);

		// TODO
		console.log(
			bankDepositTokenAmountAfter.toString(),
			bankBorrowTokenAmountAfter.toString()
		);
		assert(bankDepositTokenAmountAfter.eq(bankBorrowTokenAmountAfter));
	});

	it('Update Cumulative Interest with 100% utilization', async () => {
		const usdcBankIndex = new BN(0);
		const oldBankAccount = firstUserClearingHouse.getBankAccount(usdcBankIndex);

		await sleep(5000);

		const txSig = await firstUserClearingHouse.updateBankCumulativeInterest(
			usdcBankIndex
		);
		await printTxLogs(connection, txSig);

		await firstUserClearingHouse.fetchAccounts();
		const newBankAccount = firstUserClearingHouse.getBankAccount(usdcBankIndex);

		const expectedInterestAccumulated = calculateInterestAccumulated(
			oldBankAccount,
			newBankAccount.lastInterestTs
		);
		const expectedCumulativeDepositInterest =
			oldBankAccount.cumulativeDepositInterest.add(
				expectedInterestAccumulated.depositInterest
			);
		const expectedCumulativeBorrowInterest =
			oldBankAccount.cumulativeBorrowInterest.add(
				expectedInterestAccumulated.borrowInterest
			);

		assert(
			newBankAccount.cumulativeDepositInterest.eq(
				expectedCumulativeDepositInterest
			)
		);
		assert(
			newBankAccount.cumulativeBorrowInterest.eq(
				expectedCumulativeBorrowInterest
			)
		);
	});

	it('Flip second user borrow to deposit', async () => {
		const bankIndex = new BN(0);
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
			secondUserClearingHouse.getUserBankBalance(bankIndex).balance;
		const bankDepositBalanceBefore =
			secondUserClearingHouse.getBankAccount(bankIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.add(mintAmount.div(new BN(2)));
		const txSig = await secondUserClearingHouse.deposit(
			depositAmount,
			bankIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		await secondUserClearingHouse.fetchAccounts();
		const bankAccount = secondUserClearingHouse.getBankAccount(bankIndex);
		const borrowToPayOff = getTokenAmount(
			userBorrowBalanceBefore,
			bankAccount,
			BankBalanceType.BORROW
		);
		const newDepositTokenAmount = depositAmount.sub(borrowToPayOff);

		const expectedUserBalance = getBalance(
			newDepositTokenAmount,
			bankAccount,
			BankBalanceType.DEPOSIT
		);
		const userBalanceAfter =
			secondUserClearingHouse.getUserBankBalance(bankIndex);

		assert(expectedUserBalance.eq(userBalanceAfter.balance));
		assert(isVariant(userBalanceAfter.balanceType, 'deposit'));

		const expectedBankDepositBalance =
			bankDepositBalanceBefore.add(expectedUserBalance);
		assert(bankAccount.depositBalance.eq(expectedBankDepositBalance));
		assert(bankAccount.borrowBalance.eq(ZERO));
	});

	it('Flip second user deposit to borrow', async () => {
		const bankIndex = new BN(0);

		const bankAccountBefore = secondUserClearingHouse.getBankAccount(bankIndex);
		const userDepositBalanceBefore =
			secondUserClearingHouse.getUserBankBalance(bankIndex).balance;
		const bankDepositBalanceBefore =
			secondUserClearingHouse.getBankAccount(bankIndex).depositBalance;
		const userDepositokenAmountBefore = getTokenAmount(
			userDepositBalanceBefore,
			bankAccountBefore,
			BankBalanceType.DEPOSIT
		);

		const borrowAmount = userDepositokenAmountBefore.add(new BN(1 * 10 ** 6));
		const txSig = await secondUserClearingHouse.withdraw(
			borrowAmount,
			bankIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		await secondUserClearingHouse.fetchAccounts();
		const bankAccount = secondUserClearingHouse.getBankAccount(bankIndex);
		const depositToWithdrawAgainst = getTokenAmount(
			userDepositBalanceBefore,
			bankAccount,
			BankBalanceType.DEPOSIT
		);
		const newBorrowTokenAmount = borrowAmount.sub(depositToWithdrawAgainst);

		const expectedUserBalance = getBalance(
			newBorrowTokenAmount,
			bankAccount,
			BankBalanceType.BORROW
		);
		const userBalanceAfter =
			secondUserClearingHouse.getUserBankBalance(bankIndex);

		assert(expectedUserBalance.eq(userBalanceAfter.balance));
		assert(isVariant(userBalanceAfter.balanceType, 'borrow'));

		const expectedBankDepositBalance = bankDepositBalanceBefore.sub(
			userDepositBalanceBefore
		);
		assert(bankAccount.depositBalance.eq(expectedBankDepositBalance));
		assert(bankAccount.borrowBalance.eq(expectedUserBalance));
	});

	it('Second user reduce only pay down borrow', async () => {
		const bankIndex = new BN(0);
		const userUSDCAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseUSDCAccount
		);
		const currentUserBorrowBalance =
			secondUserClearingHouse.getUserBankBalance(bankIndex).balance;
		const bankDepositBalanceBefore =
			secondUserClearingHouse.getBankAccount(bankIndex).depositBalance;

		const depositAmount = userUSDCAmountBefore.mul(new BN(100000)); // huge number
		const txSig = await secondUserClearingHouse.deposit(
			depositAmount,
			bankIndex,
			secondUserClearingHouseUSDCAccount,
			undefined,
			true
		);
		await printTxLogs(connection, txSig);

		const bankAccountAfter = secondUserClearingHouse.getBankAccount(bankIndex);
		const borrowToPayBack = getTokenAmount(
			currentUserBorrowBalance,
			bankAccountAfter,
			BankBalanceType.BORROW
		);

		const userUSDCAmountAfter = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseUSDCAccount
		);
		const expectedUserUSDCAmount = userUSDCAmountBefore.sub(borrowToPayBack);
		assert(expectedUserUSDCAmount.eq(userUSDCAmountAfter));

		const userBalanceAfter =
			secondUserClearingHouse.getUserBankBalance(bankIndex);
		assert(userBalanceAfter.balance.eq(ZERO));

		assert(bankAccountAfter.borrowBalance.eq(ZERO));
		assert(bankAccountAfter.depositBalance.eq(bankDepositBalanceBefore));
	});

	it('Second user reduce only withdraw deposit', async () => {
		const bankIndex = new BN(1);
		const userWSOLAmountBefore = await getTokenAmountAsBN(
			connection,
			secondUserClearingHouseWSOLAccount
		);

		const currentUserDepositBalance =
			secondUserClearingHouse.getUserBankBalance(bankIndex).balance;

		const withdrawAmount = new BN(LAMPORTS_PER_SOL * 100);
		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			bankIndex,
			secondUserClearingHouseWSOLAccount,
			true
		);
		await printTxLogs(connection, txSig);

		const bankAccountAfter = secondUserClearingHouse.getBankAccount(bankIndex);
		const amountAbleToWithdraw = getTokenAmount(
			currentUserDepositBalance,
			bankAccountAfter,
			BankBalanceType.DEPOSIT
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
			secondUserClearingHouse.getUserBankBalance(bankIndex);
		assert(userBalanceAfter.balance.eq(ZERO));
	});
});
