import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	ClearingHouse,
	ClearingHouseUser,
	EventSubscriber,
	BANK_RATE_PRECISION,
	BANK_INTEREST_PRECISION,
	BankBalanceType,
	isVariant,
	OracleSource,
	BANK_WEIGHT_PRECISION,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { getBalance } from '../sdk/src/math/bankBalance';

describe('bank', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let admin: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let adminUSDCAccount;

	let firstUserKeypair: Keypair;
	let firstUserClearingHouse: ClearingHouse;
	let firstUserClearingHouseUser: ClearingHouseUser;
	let firstUserClearingHouseUSDCAccount: PublicKey;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		adminUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider
		);

		admin = Admin.from(connection, provider.wallet, chProgram.programId, {
			commitment: 'confirmed',
		});

		await admin.initialize(usdcMint.publicKey, true);
		await admin.subscribe();
	});

	after(async () => {
		await admin.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize Banks', async () => {
		const optimalUtilization = BANK_RATE_PRECISION.div(new BN(2)); // 50% utilization
		const optimalRate = BANK_RATE_PRECISION.mul(new BN(20)); // 20% APR
		const maxRate = BANK_RATE_PRECISION.mul(new BN(50)); // 50% APR
		await admin.initializeBank(
			usdcMint.publicKey,
			optimalUtilization,
			optimalRate,
			maxRate,
			PublicKey.default,
			OracleSource.QUOTE_ASSET,
			BANK_WEIGHT_PRECISION,
			BANK_WEIGHT_PRECISION
		);

		await admin.fetchAccounts();
		const bank = await admin.getBankAccount(0);
		assert(bank.bankIndex.eq(new BN(0)));
		assert(bank.optimalUtilization.eq(optimalUtilization));
		assert(bank.optimalBorrowRate.eq(optimalRate));
		assert(bank.maxBorrowRate.eq(maxRate));
		assert(bank.cumulativeBorrowInterest.eq(BANK_INTEREST_PRECISION));
		assert(bank.cumulativeDepositInterest.eq(BANK_INTEREST_PRECISION));

		assert(admin.getStateAccount().numberOfBanks.eq(new BN(1)));
	});

	it('Deposit', async () => {
		[firstUserClearingHouse, firstUserClearingHouseUSDCAccount] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount
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
});
