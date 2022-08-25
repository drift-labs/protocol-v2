import * as anchor from '@project-serum/anchor';
import { assert, expect } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	Admin,
	BN,
	OracleSource,
	EventSubscriber,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	ZERO,
	QUOTE_ASSET_BANK_INDEX,
	QUOTE_PRECISION,
	ONE,
	getTokenAmount,
	BankBalanceType,
	getBalance,
	isVariant,
	BANK_RATE_PRECISION,
	BANK_INTEREST_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteAssetBank,
	initializeSolAssetBank,
	createUserWithUSDCAndWSOLAccount,
	printTxLogs,
	mintToInsuranceFund,
	sleep,
} from './testHelpers';
import { getTokenAccount } from '@project-serum/common';

describe('insurance fund stake', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;

	const usdcAmount = new BN(1000000 * 10 ** 6); //1M

	let secondUserClearingHouse: ClearingHouse;
	let secondUserClearingHouseWSOLAccount: PublicKey;
	let secondUserClearingHouseUSDCAccount: PublicKey;

	const solAmount = new BN(10000 * 10 ** 9);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			provider
		);

		solOracle = await mockOracle(22500); // a future we all need to believe in

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await initializeSolAssetBank(clearingHouse, solOracle);

		const userId = 0;
		const name = 'BIGZ';
		await clearingHouse.initializeUserAccount(userId, name);
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_ASSET_BANK_INDEX,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize if stake', async () => {
		const bankIndex = new BN(0);
		await clearingHouse.initializeInsuranceFundStake(bankIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);
		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.bankIndex.eq(bankIndex));
		assert(ifStakeAccount.authority.equals(provider.wallet.publicKey));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.numberOfUsers === 1);
		assert(userStats.quoteAssetInsuranceFundStake.eq(ZERO));
	});

	it('user if stake', async () => {
		const bankIndex = new BN(0);
		try {
			const txSig = await clearingHouse.addInsuranceFundStake(
				bankIndex,
				usdcAmount,
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		assert(bank0.insuranceFundPool.balance.eq(ZERO));
		assert(bank0.totalLpShares.gt(ZERO));
		assert(bank0.totalLpShares.eq(usdcAmount));
		assert(bank0.userLpShares.eq(usdcAmount));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.quoteAssetInsuranceFundStake.eq(usdcAmount));
	});

	it('user request if unstake (half)', async () => {
		const bankIndex = new BN(0);
		const nShares = usdcAmount.div(new BN(2));
		try {
			const txSig = await clearingHouse.requestRemoveInsuranceFundStake(
				bankIndex,
				nShares
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		assert(bank0.totalLpShares.gt(ZERO));
		assert(bank0.totalLpShares.eq(usdcAmount));
		assert(bank0.userLpShares.eq(usdcAmount));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.quoteAssetInsuranceFundStake.eq(usdcAmount));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});

	it('user if unstake (half)', async () => {
		const bankIndex = new BN(0);
		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await clearingHouse.removeInsuranceFundStake(
			bankIndex,
			userUSDCAccount.publicKey
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		console.log('totalLpShares:', bank0.totalLpShares.toString());
		console.log('userLpShares:', bank0.userLpShares.toString());

		assert(bank0.totalLpShares.eq(usdcAmount.div(new BN(2))));
		assert(bank0.userLpShares.eq(usdcAmount.div(new BN(2))));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(
			userStats.quoteAssetInsuranceFundStake.eq(usdcAmount.div(new BN(2)))
		);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);

		const balance = await connection.getBalance(userUSDCAccount.publicKey);
		console.log('sol balance:', balance.toString());
		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '499999999999');

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));
	});

	it('user request if unstake with escrow period (last half)', async () => {
		const txSig = await clearingHouse.updateBankInsuranceWithdrawEscrowPeriod(
			new BN(0),
			new BN(10)
		);
		await printTxLogs(connection, txSig);

		const bankIndex = new BN(0);
		const nShares = usdcAmount.div(new BN(2));
		const txSig2 = await clearingHouse.requestRemoveInsuranceFundStake(
			bankIndex,
			nShares
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig2, { commitment: 'confirmed' }))
				.meta.logMessages
		);

		try {
			const txSig3 = await clearingHouse.removeInsuranceFundStake(
				bankIndex,
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig3, { commitment: 'confirmed' }))
					.meta.logMessages
			);
			assert(false); // todo
		} catch (e) {
			console.error(e);
		}

		await clearingHouse.fetchAccounts();

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		assert(bank0.insuranceWithdrawEscrowPeriod.eq(new BN(10)));
		assert(bank0.totalLpShares.gt(ZERO));
		assert(bank0.totalLpShares.eq(usdcAmount.div(new BN(2))));
		assert(bank0.userLpShares.eq(usdcAmount.div(new BN(2))));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.quoteAssetInsuranceFundStake.gt(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});

	it('user if unstake with escrow period (last half)', async () => {
		const bankIndex = new BN(0);

		try {
			await clearingHouse.updateBankReserveFactor(
				new BN(0),
				new BN(90000),
				new BN(100000)
			);
		} catch (e) {
			console.log('cant set reserve factor');
			console.error(e);
			assert(false);
		}

		let bank0Pre = clearingHouse.getBankAccount(bankIndex);
		assert(bank0Pre.insuranceWithdrawEscrowPeriod.eq(new BN(10)));

		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const ifStakePublicKeyPre = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);

		let ifStakeAccountPre =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKeyPre
			)) as InsuranceFundStake;

		while (
			ifStakeAccountPre.lastWithdrawRequestTs
				.add(bank0Pre.insuranceWithdrawEscrowPeriod)
				.gte(new BN(now))
		) {
			console.log(
				ifStakeAccountPre.lastWithdrawRequestTs.toString(),
				' + ',
				bank0Pre.insuranceWithdrawEscrowPeriod.toString(),
				'>',
				now
			);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await clearingHouse.removeInsuranceFundStake(
			bankIndex,
			userUSDCAccount.publicKey
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const bank0 = clearingHouse.getBankAccount(bankIndex);
		console.log('totalLpShares:', bank0.totalLpShares.toString());
		console.log('userLpShares:', bank0.userLpShares.toString());

		assert(bank0.totalLpShares.eq(ZERO));
		assert(bank0.userLpShares.eq(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.quoteAssetInsuranceFundStake.eq(ZERO));

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '999999999999');
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
			[new BN(0)],
			[new BN(0), new BN(1)],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			]
		);

		const bankIndex = new BN(1);
		const txSig = await secondUserClearingHouse.deposit(
			solAmount,
			bankIndex,
			secondUserClearingHouseWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const bank = await clearingHouse.getBankAccount(bankIndex);
		console.log(bank.depositBalance.toString());
		// assert(bank.depositBalance.eq('10000000000'));

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

		const bank = await clearingHouse.getBankAccount(bankIndex);
		const expectedBorrowBalance = new BN(500000000001);
		console.log('bank.borrowBalance:', bank.borrowBalance.toString());
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

	it('if pool revenue from borrows', async () => {
		let bank = clearingHouse.getBankAccount(0);

		// await mintToInsuranceFund(
		// 	bank.insuranceFundVault,
		// 	usdcMint,
		// 	new BN(80085).mul(QUOTE_PRECISION),
		// 	provider
		// );

		const ifPoolBalance = getTokenAmount(
			bank.insuranceFundPool.balance,
			bank,
			BankBalanceType.DEPOSIT
		);

		assert(bank.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		await clearingHouse.updateBankCumulativeInterest(new BN(0));

		await clearingHouse.fetchAccounts();
		bank = clearingHouse.getBankAccount(0);

		console.log(
			'cumulativeBorrowInterest:',
			bank.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			bank.cumulativeDepositInterest.toString()
		);

		assert(bank.cumulativeBorrowInterest.gt(BANK_INTEREST_PRECISION));
		assert(bank.cumulativeDepositInterest.gt(BANK_INTEREST_PRECISION));

		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank.insuranceFundVault
				)
			).value.amount
		);
		console.log('insuranceVaultAmount:', insuranceVaultAmountBefore.toString());

		assert(insuranceVaultAmountBefore.eq(ONE));

		try {
			const txSig = await clearingHouse.settleBankToInsuranceFund(new BN(0));
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const insuranceVaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank.insuranceFundVault
				)
			).value.amount
		);
		console.log(
			'insuranceVaultAmount:',
			insuranceVaultAmountBefore.toString(),
			'->',
			insuranceVaultAmount.toString()
		);
		assert(insuranceVaultAmount.gt(ONE));
	});
});
