import * as anchor from '@project-serum/anchor';
import { assert, expect } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	Admin,
	ClearingHouseUser,
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
	PEG_PRECISION,
	BANK_INTEREST_PRECISION,
	findComputeUnitConsumption,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	unstakeSharesToAmount,
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
	setFeedPrice,
	sleep,
	getTokenAmountAsBN,
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

		const periodicity = new BN(60 * 60); // 1 HOUR
		await clearingHouse.initializeMarket(
			solOracle,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION,
			periodicity,
			new BN(22500 * PEG_PRECISION.toNumber()),
			undefined,
			1000
		);
		await clearingHouse.updateMarketBaseSpread(new BN(0), 2000);
		await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

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
		assert(bank0.revenuePool.balance.eq(ZERO));
		assert(bank0.totalIfShares.gt(ZERO));
		assert(bank0.totalIfShares.eq(usdcAmount));
		assert(bank0.userIfShares.eq(usdcAmount));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.quoteAssetInsuranceFundStake.eq(usdcAmount));
	});

	it('user request if unstake (half)', async () => {
		const bankIndex = new BN(0);
		const nShares = usdcAmount.div(new BN(2));

		const bank0Before = clearingHouse.getBankAccount(bankIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank0Before.insuranceFundVault
				)
			).value.amount
		);

		const amountFromShare = unstakeSharesToAmount(
			nShares,
			bank0Before.totalIfShares,
			insuranceVaultAmountBefore
		);

		try {
			const txSig = await clearingHouse.requestRemoveInsuranceFundStake(
				bankIndex,
				amountFromShare.add(ONE)
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
		assert(bank0.totalIfShares.gt(ZERO));
		assert(bank0.totalIfShares.eq(usdcAmount));
		assert(bank0.userIfShares.eq(usdcAmount));

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
		assert(ifStakeAccount.lastWithdrawRequestShares.eq(nShares));
		assert(ifStakeAccount.lastWithdrawRequestValue.eq(amountFromShare));
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
		console.log('totalIfShares:', bank0.totalIfShares.toString());
		console.log('userIfShares:', bank0.userIfShares.toString());

		assert(bank0.totalIfShares.eq(usdcAmount.div(new BN(2))));
		assert(bank0.userIfShares.eq(usdcAmount.div(new BN(2))));

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
		assert(bank0.totalIfShares.gt(ZERO));
		assert(bank0.totalIfShares.eq(usdcAmount.div(new BN(2))));
		assert(bank0.userIfShares.eq(usdcAmount.div(new BN(2))));

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
			await clearingHouse.updateBankIfFactor(
				new BN(0),
				new BN(90000),
				new BN(100000),
				new BN(50000)
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
		console.log('totalIfShares:', bank0.totalIfShares.toString());
		console.log('userIfShares:', bank0.userIfShares.toString());

		assert(bank0.totalIfShares.eq(ZERO));
		assert(bank0.userIfShares.eq(ZERO));

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
			bank.revenuePool.balance,
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
		const ifPoolBalanceAfterUpdate = getTokenAmount(
			bank.revenuePool.balance,
			bank,
			BankBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterUpdate.gt(new BN(0)));
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
			const txSig = await clearingHouse.settleRevenueToInsuranceFund(new BN(0));
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

		await clearingHouse.fetchAccounts();
		bank = clearingHouse.getBankAccount(0);
		const ifPoolBalanceAfterSettle = getTokenAmount(
			bank.revenuePool.balance,
			bank,
			BankBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterSettle.eq(new BN(0)));
	});

	it('no user -> user stake when there is a vault balance', async () => {
		const bankIndex = new BN(0);
		const bank0Before = clearingHouse.getBankAccount(bankIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(bank0Before.revenuePool.balance.eq(ZERO));

		assert(bank0Before.userIfShares.eq(ZERO));
		assert(bank0Before.totalIfShares.eq(ZERO));

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '999999999999');

		try {
			const txSig = await clearingHouse.addInsuranceFundStake(
				bankIndex,
				new BN(usdcbalance.value.amount),
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const bank0 = clearingHouse.getBankAccount(bankIndex);
		assert(bank0.revenuePool.balance.eq(ZERO));
		const insuranceVaultAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		console.log(
			'userIfShares:',
			bank0.userIfShares.toString(),
			'totalIfShares:',
			bank0.totalIfShares.toString()
		);
		assert(bank0.totalIfShares.gt(ZERO));
		assert(bank0.totalIfShares.gt(usdcAmount));
		assert(bank0.totalIfShares.gt(new BN('1000000004698')));
		// totalIfShares lower bound, kinda random basd on timestamps

		assert(bank0.userIfShares.eq(new BN(usdcbalance.value.amount)));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(
			userStats.quoteAssetInsuranceFundStake.eq(
				new BN(usdcbalance.value.amount)
			)
		);
	});

	it('user stake misses out on gains during escrow period after cancel', async () => {
		const bankIndex = new BN(0);
		const bank0Before = clearingHouse.getBankAccount(bankIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(bank0Before.revenuePool.balance.eq(ZERO));

		console.log(
			'cumulativeBorrowInterest:',
			bank0Before.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			bank0Before.cumulativeDepositInterest.toString()
		);

		// user requests partial withdraw
		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			bankIndex
		);
		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		const amountFromShare = unstakeSharesToAmount(
			ifStakeAccount.ifShares.div(new BN(10)),
			bank0Before.totalIfShares,
			insuranceVaultAmountBefore
		);

		const txSig2 = await clearingHouse.requestRemoveInsuranceFundStake(
			bankIndex,
			amountFromShare
		);

		console.log('letting interest accum (2s)');
		await sleep(2000);
		await clearingHouse.updateBankCumulativeInterest(new BN(0));
		const bankIUpdate = await clearingHouse.getBankAccount(bankIndex);

		console.log(
			'cumulativeBorrowInterest:',
			bankIUpdate.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			bankIUpdate.cumulativeDepositInterest.toString()
		);

		console.log(bankIUpdate.revenuePool.balance.toString());
		assert(bankIUpdate.revenuePool.balance.gt(ZERO));

		try {
			const txSig = await clearingHouse.settleRevenueToInsuranceFund(bankIndex);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const insuranceVaultAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					bank0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		const txSig3 = await clearingHouse.cancelRequestRemoveInsuranceFundStake(
			bankIndex
		);

		const ifStakeAccountAfter =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		const userStats = clearingHouse.getUserStats().getAccount();

		console.log(
			'ifshares:',
			ifStakeAccount.ifShares.toString(),
			'->',
			ifStakeAccountAfter.ifShares.toString(),
			'(quoteAssetInsuranceFundStake=',
			userStats.quoteAssetInsuranceFundStake.toString(),
			')'
		);

		assert(ifStakeAccountAfter.ifShares.lt(ifStakeAccount.ifShares));

		// totalIfShares lower bound, kinda random basd on timestamps
		assert(
			userStats.quoteAssetInsuranceFundStake.eq(ifStakeAccountAfter.ifShares)
		);
	});

	it('liquidate borrow (w/ IF revenue)', async () => {
		const bankBefore = clearingHouse.getBankAccount(0);

		const ifPoolBalance = getTokenAmount(
			bankBefore.revenuePool.balance,
			bankBefore,
			BankBalanceType.DEPOSIT
		);

		assert(bankBefore.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse: secondUserClearingHouse,
			userAccountPublicKey:
				await secondUserClearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const prevTC = clearingHouseUser.getTotalCollateral();

		await setFeedPrice(anchor.workspace.Pyth, 22500 / 10000, solOracle); // down 99.99%
		await sleep(2000);

		await clearingHouseUser.fetchAccounts();

		const newTC = clearingHouseUser.getTotalCollateral();
		console.log(
			"Borrower's TotalCollateral: ",
			convertToNumber(prevTC, QUOTE_PRECISION),
			'->',
			convertToNumber(newTC, QUOTE_PRECISION)
		);
		assert(!prevTC.eq(newTC));

		assert(clearingHouseUser.canBeLiquidated()[0]);

		const beforecbb0 = clearingHouse.getUserAccount().bankBalances[0];
		const beforecbb1 = clearingHouse.getUserAccount().bankBalances[1];

		const beforeLiquiderUSDCDeposit = getTokenAmount(
			beforecbb0.balance,
			bankBefore,
			BankBalanceType.DEPOSIT
		);

		const beforeLiquiderSOLDeposit = getTokenAmount(
			beforecbb1.balance,
			bankBefore,
			BankBalanceType.DEPOSIT
		);

		console.log(
			'LD:',
			beforeLiquiderUSDCDeposit.toString(),
			beforeLiquiderSOLDeposit.toString()
		);

		assert(beforecbb0.bankIndex.eq(ZERO));
		// assert(beforecbb1.bankIndex.eq(ONE));
		assert(isVariant(beforecbb0.balanceType, 'deposit'));
		// assert(isVariant(beforecbb1.balanceType, 'deposit'));

		const beforebb0 = secondUserClearingHouse.getUserAccount().bankBalances[0];
		const beforebb1 = secondUserClearingHouse.getUserAccount().bankBalances[1];

		const usdcDepositsBefore = getTokenAmount(
			bankBefore.depositBalance,
			bankBefore,
			BankBalanceType.DEPOSIT
		);

		const beforeLiquiteeUSDCBorrow = getTokenAmount(
			beforebb0.balance,
			bankBefore,
			BankBalanceType.BORROW
		);

		const beforeLiquiteeSOLDeposit = getTokenAmount(
			beforebb1.balance,
			bankBefore,
			BankBalanceType.DEPOSIT
		);

		console.log(
			'LT:',
			beforeLiquiteeUSDCBorrow.toString(),
			beforeLiquiteeSOLDeposit.toString()
		);

		assert(beforebb0.bankIndex.eq(ZERO));
		assert(beforebb1.bankIndex.eq(ONE));
		assert(isVariant(beforebb0.balanceType, 'borrow'));
		assert(isVariant(beforebb1.balanceType, 'deposit'));

		assert(beforeLiquiderUSDCDeposit.gt(new BN('1000000066000')));
		assert(beforeLiquiderSOLDeposit.eq(new BN('0')));
		assert(beforeLiquiteeUSDCBorrow.gt(new BN('500000033001')));
		assert(beforeLiquiteeSOLDeposit.gt(new BN('10000000997')));

		const txSig = await clearingHouse.liquidateBorrow(
			await secondUserClearingHouse.getUserAccountPublicKey(),
			secondUserClearingHouse.getUserAccount(),
			new BN(1),
			new BN(0),
			new BN(6 * 10 ** 8)
		);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await secondUserClearingHouse.fetchAccounts();

		const bank = clearingHouse.getBankAccount(0);

		const cbb0 = clearingHouse.getUserAccount().bankBalances[0];
		const cbb1 = clearingHouse.getUserAccount().bankBalances[1];

		const afterLiquiderUSDCDeposit = getTokenAmount(
			cbb0.balance,
			bank,
			BankBalanceType.DEPOSIT
		);

		const afterLiquiderSOLDeposit = getTokenAmount(
			cbb1.balance,
			bank,
			BankBalanceType.DEPOSIT
		);

		console.log(
			'LD:',
			afterLiquiderUSDCDeposit.toString(),
			afterLiquiderSOLDeposit.toString()
		);

		assert(cbb0.bankIndex.eq(ZERO));
		assert(cbb1.bankIndex.eq(ONE));
		assert(isVariant(cbb0.balanceType, 'deposit'));
		assert(isVariant(cbb1.balanceType, 'deposit'));

		const bb0 = secondUserClearingHouse.getUserAccount().bankBalances[0];
		const bb1 = secondUserClearingHouse.getUserAccount().bankBalances[1];

		const afterLiquiteeUSDCBorrow = getTokenAmount(
			bb0.balance,
			bank,
			BankBalanceType.BORROW
		);

		const afterLiquiteeSOLDeposit = getTokenAmount(
			bb1.balance,
			bank,
			BankBalanceType.DEPOSIT
		);

		console.log(
			'LT:',
			afterLiquiteeUSDCBorrow.toString(),
			afterLiquiteeSOLDeposit.toString()
		);

		assert(bb0.bankIndex.eq(ZERO));
		assert(bb1.bankIndex.eq(ONE));
		assert(isVariant(bb0.balanceType, 'borrow'));
		assert(isVariant(bb1.balanceType, 'deposit'));

		assert(afterLiquiderUSDCDeposit.gt(new BN('999400065806')));
		assert(afterLiquiderSOLDeposit.gt(new BN('266660042')));
		assert(afterLiquiteeUSDCBorrow.gt(new BN('499430033054')));
		assert(afterLiquiteeSOLDeposit.gt(new BN('9733336051')));

		// console.log(
		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.bankBalances[0].balance.toString(),

		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.bankBalances[0].bankIndex.toString(),
		// 	secondUserClearingHouse.getUserAccount().bankBalances[0].balanceType
		// );

		// console.log(
		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.bankBalances[1].balance.toString(),

		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.bankBalances[1].bankIndex.toString(),
		// 	secondUserClearingHouse.getUserAccount().bankBalances[1].balanceType
		// );

		assert(secondUserClearingHouse.getUserAccount().beingLiquidated);
		assert(!secondUserClearingHouse.getUserAccount().bankrupt);

		const ifPoolBalanceAfter = getTokenAmount(
			bank.revenuePool.balance,
			bank,
			BankBalanceType.DEPOSIT
		);
		console.log('ifPoolBalance: 0 ->', ifPoolBalanceAfter.toString());

		assert(ifPoolBalanceAfter.gt(new BN('20004698')));

		const usdcBefore = ifPoolBalanceAfter
			.add(afterLiquiderUSDCDeposit)
			.sub(afterLiquiteeUSDCBorrow);

		const usdcAfter = ZERO.add(beforeLiquiderUSDCDeposit).sub(
			beforeLiquiteeUSDCBorrow
		);

		const usdcDepositsAfter = getTokenAmount(
			bank.depositBalance,
			bank,
			BankBalanceType.DEPOSIT
		);

		console.log(
			'usdc borrows in bank:',
			getTokenAmount(
				bankBefore.borrowBalance,
				bankBefore,
				BankBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				bank.borrowBalance,
				bank,
				BankBalanceType.BORROW
			).toString()
		);

		console.log(
			'usdc balances in bank:',
			bankBefore.depositBalance.toString(),
			'->',
			bank.depositBalance.toString()
		);

		console.log(
			'usdc cum dep interest in bank:',
			bankBefore.cumulativeDepositInterest.toString(),
			'->',
			bank.cumulativeDepositInterest.toString()
		);

		console.log(
			'usdc deposits in bank:',
			usdcDepositsBefore.toString(),
			'->',
			usdcDepositsAfter.toString()
		);

		console.log(
			'usdc for users:',
			usdcBefore.toString(),
			'->',
			usdcAfter.toString()
		);

		// TODO: resolve any issues in liq borrow before adding asserts in test here

		// assert(usdcBefore.eq(usdcAfter));
	});

	// it('settle bank to insurance vault', async () => {
	// 	const bankIndex = new BN(0);

	// 	const bank0Before = clearingHouse.getBankAccount(bankIndex);

	// 	const insuranceVaultAmountBefore = new BN(
	// 		(
	// 			await provider.connection.getTokenAccountBalance(
	// 				bank0Before.insuranceFundVault
	// 			)
	// 		).value.amount
	// 	);

	// 	assert(insuranceVaultAmountBefore.gt(ZERO));
	// 	assert(bank0Before.revenuePool.balance.gt(ZERO));

	// 	console.log(
	// 		'userIfShares:',
	// 		bank0Before.userIfShares.toString(),
	// 		'totalIfShares:',
	// 		bank0Before.totalIfShares.toString()
	// 	);
	// 	assert(bank0Before.userIfShares.eq(ZERO));
	// 	assert(bank0Before.totalIfShares.eq(ZERO)); // 0_od

	// 	try {
	// 		const txSig = await clearingHouse.settleRevenueToInsuranceFund(bankIndex);
	// 		console.log(
	// 			'tx logs',
	// 			(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
	// 				.meta.logMessages
	// 		);
	// 	} catch (e) {
	// 		console.error(e);
	// 		assert(false);
	// 	}

	// 	const bank0 = clearingHouse.getBankAccount(bankIndex);
	// 	assert(bank0.revenuePool.balance.eq(ZERO));
	// 	assert(bank0.totalIfShares.eq(ZERO));
	// });
});
