import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	Admin,
	OracleGuardRails,
	ClearingHouse,
	ClearingHouseUser,
	BN,
	OracleSource,
	EventSubscriber,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	ZERO,
	QUOTE_SPOT_MARKET_INDEX,
	QUOTE_PRECISION,
	ONE,
	getTokenAmount,
	SpotBalanceType,
	getBalance,
	isVariant,
	PEG_PRECISION,
	SPOT_MARKET_RATE_PRECISION,
	findComputeUnitConsumption,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	unstakeSharesToAmount,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	printTxLogs,
	setFeedPrice,
	sleep,
} from './testHelpers';

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
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
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

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);

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
		await clearingHouse.updateMarketBaseSpread(0, 2000);
		await clearingHouse.updateCurveUpdateIntensity(0, 100);

		const userId = 0;
		const name = 'BIGZ';
		await clearingHouse.initializeUserAccount(userId, name);
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await secondUserClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize if stake', async () => {
		const marketIndex = 0;
		await clearingHouse.initializeInsuranceFundStake(marketIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === marketIndex);
		assert(ifStakeAccount.authority.equals(provider.wallet.publicKey));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.numberOfUsers === 1);
		assert(userStats.stakedQuoteAssetAmount.eq(ZERO));
	});

	it('user if stake', async () => {
		const marketIndex = 0;
		try {
			const txSig = await clearingHouse.addInsuranceFundStake(
				marketIndex,
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

		const spotMarket0 = clearingHouse.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.revenuePool.balance.eq(ZERO));
		assert(spotMarket0.totalIfShares.gt(ZERO));
		assert(spotMarket0.totalIfShares.eq(usdcAmount));
		assert(spotMarket0.userIfShares.eq(usdcAmount));

		const userStats = clearingHouse.getUserStats().getAccount();
		console.log(userStats);
		assert(userStats.stakedQuoteAssetAmount.eq(usdcAmount));
	});

	it('user request if unstake (half)', async () => {
		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));

		const spotMarket0Before = clearingHouse.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFundVault
				)
			).value.amount
		);

		const amountFromShare = unstakeSharesToAmount(
			nShares,
			spotMarket0Before.totalIfShares,
			insuranceVaultAmountBefore
		);

		console.log(amountFromShare.toString());

		try {
			const txSig = await clearingHouse.requestRemoveInsuranceFundStake(
				marketIndex,
				amountFromShare
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = clearingHouse.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.totalIfShares.gt(ZERO));
		assert(spotMarket0.totalIfShares.eq(usdcAmount));
		assert(spotMarket0.userIfShares.eq(usdcAmount));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.stakedQuoteAssetAmount.eq(usdcAmount));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
		console.log(ifStakeAccount.lastWithdrawRequestShares.toString());
		console.log(nShares.toString());
		assert(ifStakeAccount.lastWithdrawRequestShares.eq(nShares));
		assert(ifStakeAccount.lastWithdrawRequestValue.eq(amountFromShare));
	});

	it('user if unstake (half)', async () => {
		const marketIndex = 0;
		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await clearingHouse.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const spotMarket0 = clearingHouse.getSpotMarketAccount(marketIndex);
		console.log('totalIfShares:', spotMarket0.totalIfShares.toString());
		console.log('userIfShares:', spotMarket0.userIfShares.toString());

		assert(spotMarket0.totalIfShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.userIfShares.eq(usdcAmount.div(new BN(2))));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.stakedQuoteAssetAmount.eq(usdcAmount.div(new BN(2))));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const balance = await connection.getBalance(userUSDCAccount.publicKey);
		console.log('sol balance:', balance.toString());
		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '500000000000');

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));
	});

	it('user request if unstake with escrow period (last half)', async () => {
		const txSig = await clearingHouse.updateInsuranceWithdrawEscrowPeriod(
			0,
			new BN(10)
		);
		await printTxLogs(connection, txSig);

		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));
		const txSig2 = await clearingHouse.requestRemoveInsuranceFundStake(
			marketIndex,
			nShares
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig2, { commitment: 'confirmed' }))
				.meta.logMessages
		);

		try {
			const txSig3 = await clearingHouse.removeInsuranceFundStake(
				marketIndex,
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

		const spotMarket0 = clearingHouse.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceWithdrawEscrowPeriod.eq(new BN(10)));
		assert(spotMarket0.totalIfShares.gt(ZERO));
		assert(spotMarket0.totalIfShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.userIfShares.eq(usdcAmount.div(new BN(2))));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.stakedQuoteAssetAmount.gt(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});

	it('user if unstake with escrow period (last half)', async () => {
		const marketIndex = 0;

		try {
			await clearingHouse.updateSpotMarketIfFactor(
				0,
				new BN(90000),
				new BN(100000)
			);
		} catch (e) {
			console.log('cant set reserve factor');
			console.error(e);
			assert(false);
		}

		const spotMarket0Pre = clearingHouse.getSpotMarketAccount(marketIndex);
		assert(spotMarket0Pre.insuranceWithdrawEscrowPeriod.eq(new BN(10)));

		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const ifStakePublicKeyPre = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccountPre =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKeyPre
			)) as InsuranceFundStake;

		while (
			ifStakeAccountPre.lastWithdrawRequestTs
				.add(spotMarket0Pre.insuranceWithdrawEscrowPeriod)
				.gte(new BN(now))
		) {
			console.log(
				ifStakeAccountPre.lastWithdrawRequestTs.toString(),
				' + ',
				spotMarket0Pre.insuranceWithdrawEscrowPeriod.toString(),
				'>',
				now
			);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await clearingHouse.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const spotMarket0 = clearingHouse.getSpotMarketAccount(marketIndex);
		console.log('totalIfShares:', spotMarket0.totalIfShares.toString());
		console.log('userIfShares:', spotMarket0.userIfShares.toString());

		assert(spotMarket0.totalIfShares.eq(ZERO));
		assert(spotMarket0.userIfShares.eq(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(userStats.stakedQuoteAssetAmount.eq(ZERO));

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
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			]
		);

		const marketIndex = 1;
		const txSig = await secondUserClearingHouse.deposit(
			solAmount,
			marketIndex,
			secondUserClearingHouseWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await clearingHouse.getSpotMarketAccount(marketIndex);
		console.log(spotMarket.depositBalance.toString());
		// assert(spotMarket.depositBalance.eq('10000000000'));

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
		const userspotMarketBalance =
			secondUserClearingHouse.getUserAccount().spotPositions[1];
		assert(isVariant(userspotMarketBalance.balanceType, 'deposit'));
		assert(userspotMarketBalance.balance.eq(expectedBalance));
	});

	it('Second User Withdraw First half USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserClearingHouse.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserClearingHouseUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await clearingHouse.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(500000000000001);
		console.log(
			'spotMarket.borrowBalance:',
			spotMarket.borrowBalance.toString()
		);
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

		const userspotMarketBalance =
			secondUserClearingHouse.getUserAccount().spotPositions[0];
		assert(isVariant(userspotMarketBalance.balanceType, 'borrow'));
		assert(userspotMarketBalance.balance.eq(expectedBalance));

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
		let spotMarket = clearingHouse.getSpotMarketAccount(0);

		// await mintToInsuranceFund(
		// 	spotMarket.insuranceFundVault,
		// 	usdcMint,
		// 	new BN(80085).mul(QUOTE_PRECISION),
		// 	provider
		// );

		const ifPoolBalance = getTokenAmount(
			spotMarket.revenuePool.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		assert(spotMarket.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		await clearingHouse.updateSpotMarketCumulativeInterest(0);

		await clearingHouse.fetchAccounts();
		spotMarket = clearingHouse.getSpotMarketAccount(0);

		console.log(
			'cumulativeBorrowInterest:',
			spotMarket.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarket.cumulativeDepositInterest.toString()
		);
		const ifPoolBalanceAfterUpdate = getTokenAmount(
			spotMarket.revenuePool.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterUpdate.gt(new BN(0)));
		assert(spotMarket.cumulativeBorrowInterest.gt(SPOT_MARKET_RATE_PRECISION));
		assert(spotMarket.cumulativeDepositInterest.gt(SPOT_MARKET_RATE_PRECISION));

		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket.insuranceFundVault
				)
			).value.amount
		);
		console.log('insuranceVaultAmount:', insuranceVaultAmountBefore.toString());
		assert(insuranceVaultAmountBefore.eq(ONE));

		await clearingHouse.updateSpotMarketRevenueSettlePeriod(0, ONE);

		try {
			const txSig = await clearingHouse.settleRevenueToInsuranceFund(0);
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
					spotMarket.insuranceFundVault
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
		spotMarket = clearingHouse.getSpotMarketAccount(0);
		const ifPoolBalanceAfterSettle = getTokenAmount(
			spotMarket.revenuePool.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterSettle.eq(new BN(0)));
	});

	it('no user -> user stake when there is a vault balance', async () => {
		const marketIndex = 0;
		const spotMarket0Before = clearingHouse.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(spotMarket0Before.revenuePool.balance.eq(ZERO));

		assert(spotMarket0Before.userIfShares.eq(ZERO));
		assert(spotMarket0Before.totalIfShares.eq(ZERO));

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '999999999999');

		try {
			const txSig = await clearingHouse.addInsuranceFundStake(
				marketIndex,
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

		const spotMarket0 = clearingHouse.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.revenuePool.balance.eq(ZERO));
		const insuranceVaultAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		console.log(
			'userIfShares:',
			spotMarket0.userIfShares.toString(),
			'totalIfShares:',
			spotMarket0.totalIfShares.toString()
		);
		assert(spotMarket0.totalIfShares.gt(ZERO));
		assert(spotMarket0.totalIfShares.gt(usdcAmount));
		assert(spotMarket0.totalIfShares.gt(new BN('1000000004698')));
		// totalIfShares lower bound, kinda random basd on timestamps

		assert(spotMarket0.userIfShares.eq(new BN(usdcbalance.value.amount)));

		const userStats = clearingHouse.getUserStats().getAccount();
		assert(
			userStats.stakedQuoteAssetAmount.eq(new BN(usdcbalance.value.amount))
		);
	});

	it('user stake misses out on gains during escrow period after cancel', async () => {
		const marketIndex = 0;
		const spotMarket0Before = clearingHouse.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(spotMarket0Before.revenuePool.balance.eq(ZERO));

		console.log(
			'cumulativeBorrowInterest:',
			spotMarket0Before.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarket0Before.cumulativeDepositInterest.toString()
		);

		// user requests partial withdraw
		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await clearingHouse.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		const amountFromShare = unstakeSharesToAmount(
			ifStakeAccount.ifShares.div(new BN(10)),
			spotMarket0Before.totalIfShares,
			insuranceVaultAmountBefore
		);

		await clearingHouse.requestRemoveInsuranceFundStake(
			marketIndex,
			amountFromShare
		);

		console.log('letting interest accum (2s)');
		await sleep(2000);
		await clearingHouse.updateSpotMarketCumulativeInterest(0);
		const spotMarketIUpdate = await clearingHouse.getSpotMarketAccount(
			marketIndex
		);

		console.log(
			'cumulativeBorrowInterest:',
			spotMarketIUpdate.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarketIUpdate.cumulativeDepositInterest.toString()
		);

		console.log(spotMarketIUpdate.revenuePool.balance.toString());
		assert(spotMarketIUpdate.revenuePool.balance.gt(ZERO));

		try {
			const txSig = await clearingHouse.settleRevenueToInsuranceFund(
				marketIndex
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

		const insuranceVaultAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFundVault
				)
			).value.amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		const txSig = await clearingHouse.cancelRequestRemoveInsuranceFundStake(
			marketIndex
		);
		await printTxLogs(connection, txSig);

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
			userStats.stakedQuoteAssetAmount.toString(),
			')'
		);

		assert(ifStakeAccountAfter.ifShares.lt(ifStakeAccount.ifShares));

		// the user should have slightly less quote staked than the total quote in if
		assert(
			insuranceVaultAmountAfter
				.sub(userStats.stakedQuoteAssetAmount)
				.lt(QUOTE_PRECISION)
		);
	});

	it('liquidate borrow (w/ IF revenue)', async () => {
		const spotMarketBefore = clearingHouse.getSpotMarketAccount(0);

		const ifPoolBalance = getTokenAmount(
			spotMarketBefore.revenuePool.balance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		assert(spotMarketBefore.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse: secondUserClearingHouse,
			userAccountPublicKey:
				await secondUserClearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const prevTC = clearingHouseUser.getTotalCollateral();
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(100000),
			},
			useForLiquidations: false,
		};

		await clearingHouse.updateOracleGuardRails(oracleGuardRails);
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

		assert(clearingHouseUser.canBeLiquidated());

		const beforecbb0 = clearingHouse.getUserAccount().spotPositions[0];
		const beforecbb1 = clearingHouse.getUserAccount().spotPositions[1];

		const beforeLiquiderUSDCDeposit = getTokenAmount(
			beforecbb0.balance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		const beforeLiquiderSOLDeposit = getTokenAmount(
			beforecbb1.balance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LD:',
			beforeLiquiderUSDCDeposit.toString(),
			beforeLiquiderSOLDeposit.toString()
		);

		assert(beforecbb0.marketIndex === 0);
		// assert(beforecbb1.marketIndex.eq(ONE));
		assert(isVariant(beforecbb0.balanceType, 'deposit'));
		// assert(isVariant(beforecbb1.balanceType, 'deposit'));

		const beforebb0 = secondUserClearingHouse.getUserAccount().spotPositions[0];
		const beforebb1 = secondUserClearingHouse.getUserAccount().spotPositions[1];

		const usdcDepositsBefore = getTokenAmount(
			spotMarketBefore.depositBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		const beforeLiquiteeUSDCBorrow = getTokenAmount(
			beforebb0.balance,
			spotMarketBefore,
			SpotBalanceType.BORROW
		);

		const beforeLiquiteeSOLDeposit = getTokenAmount(
			beforebb1.balance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LT:',
			beforeLiquiteeUSDCBorrow.toString(),
			beforeLiquiteeSOLDeposit.toString()
		);

		assert(beforebb0.marketIndex === 0);
		assert(beforebb1.marketIndex === 1);
		assert(isVariant(beforebb0.balanceType, 'borrow'));
		assert(isVariant(beforebb1.balanceType, 'deposit'));

		assert(beforeLiquiderUSDCDeposit.gt(new BN('1000000066000')));
		assert(beforeLiquiderSOLDeposit.eq(new BN('0')));
		assert(beforeLiquiteeUSDCBorrow.gt(new BN('500000033001')));
		assert(beforeLiquiteeSOLDeposit.gt(new BN('10000000997')));

		const txSig = await clearingHouse.liquidateBorrow(
			await secondUserClearingHouse.getUserAccountPublicKey(),
			secondUserClearingHouse.getUserAccount(),
			1,
			0,
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

		const spotMarket = clearingHouse.getSpotMarketAccount(0);

		const cbb0 = clearingHouse.getUserAccount().spotPositions[0];
		const cbb1 = clearingHouse.getUserAccount().spotPositions[1];

		const afterLiquiderUSDCDeposit = getTokenAmount(
			cbb0.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		const afterLiquiderSOLDeposit = getTokenAmount(
			cbb1.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LD:',
			afterLiquiderUSDCDeposit.toString(),
			afterLiquiderSOLDeposit.toString()
		);

		assert(cbb0.marketIndex === 0);
		assert(cbb1.marketIndex === 1);
		assert(isVariant(cbb0.balanceType, 'deposit'));
		assert(isVariant(cbb1.balanceType, 'deposit'));

		const bb0 = secondUserClearingHouse.getUserAccount().spotPositions[0];
		const bb1 = secondUserClearingHouse.getUserAccount().spotPositions[1];

		const afterLiquiteeUSDCBorrow = getTokenAmount(
			bb0.balance,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const afterLiquiteeSOLDeposit = getTokenAmount(
			bb1.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LT:',
			afterLiquiteeUSDCBorrow.toString(),
			afterLiquiteeSOLDeposit.toString()
		);

		assert(bb0.marketIndex === 0);
		assert(bb1.marketIndex === 1);
		assert(isVariant(bb0.balanceType, 'borrow'));
		assert(isVariant(bb1.balanceType, 'deposit'));

		assert(afterLiquiderUSDCDeposit.gt(new BN('999400065806')));
		assert(afterLiquiderSOLDeposit.gt(new BN('266660042')));
		console.log(afterLiquiteeUSDCBorrow.toString());
		console.log(afterLiquiteeSOLDeposit.toString());
		assert(afterLiquiteeUSDCBorrow.gte(new BN('499406475800')));
		assert(afterLiquiteeSOLDeposit.gte(new BN('9733337501')));

		// console.log(
		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.spotPositions[0].balance.toString(),

		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.spotPositions[0].marketIndex.toString(),
		// 	secondUserClearingHouse.getUserAccount().spotPositions[0].balanceType
		// );

		// console.log(
		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.spotPositions[1].balance.toString(),

		// 	secondUserClearingHouse
		// 		.getUserAccount()
		// 		.spotPositions[1].marketIndex.toString(),
		// 	secondUserClearingHouse.getUserAccount().spotPositions[1].balanceType
		// );

		assert(secondUserClearingHouse.getUserAccount().beingLiquidated);
		assert(!secondUserClearingHouse.getUserAccount().bankrupt);

		const ifPoolBalanceAfter = getTokenAmount(
			spotMarket.revenuePool.balance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		console.log('ifPoolBalance: 0 ->', ifPoolBalanceAfter.toString());

		assert(ifPoolBalanceAfter.gte(new BN('6004698')));

		const usdcBefore = ifPoolBalanceAfter
			.add(afterLiquiderUSDCDeposit)
			.sub(afterLiquiteeUSDCBorrow);

		const usdcAfter = ZERO.add(beforeLiquiderUSDCDeposit).sub(
			beforeLiquiteeUSDCBorrow
		);

		const usdcDepositsAfter = getTokenAmount(
			spotMarket.depositBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'usdc borrows in spotMarket:',
			getTokenAmount(
				spotMarketBefore.borrowBalance,
				spotMarketBefore,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket.borrowBalance,
				spotMarket,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'usdc balances in spotMarket:',
			spotMarketBefore.depositBalance.toString(),
			'->',
			spotMarket.depositBalance.toString()
		);

		console.log(
			'usdc cum dep interest in spotMarket:',
			spotMarketBefore.cumulativeDepositInterest.toString(),
			'->',
			spotMarket.cumulativeDepositInterest.toString()
		);

		console.log(
			'usdc deposits in spotMarket:',
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

		await clearingHouseUser.unsubscribe();

		// TODO: resolve any issues in liq borrow before adding asserts in test here

		// assert(usdcBefore.eq(usdcAfter));
	});

	// it('settle spotMarket to insurance vault', async () => {
	// 	const marketIndex = new BN(0);

	// 	const spotMarket0Before = clearingHouse.getspotMarketAccount(marketIndex);

	// 	const insuranceVaultAmountBefore = new BN(
	// 		(
	// 			await provider.connection.getTokenAccountBalance(
	// 				spotMarket0Before.insuranceFundVault
	// 			)
	// 		).value.amount
	// 	);

	// 	assert(insuranceVaultAmountBefore.gt(ZERO));
	// 	assert(spotMarket0Before.revenuePool.balance.gt(ZERO));

	// 	console.log(
	// 		'userIfShares:',
	// 		spotMarket0Before.userIfShares.toString(),
	// 		'totalIfShares:',
	// 		spotMarket0Before.totalIfShares.toString()
	// 	);
	// 	assert(spotMarket0Before.userIfShares.eq(ZERO));
	// 	assert(spotMarket0Before.totalIfShares.eq(ZERO)); // 0_od

	// 	try {
	// 		const txSig = await clearingHouse.settleRevenueToInsuranceFund(marketIndex);
	// 		console.log(
	// 			'tx logs',
	// 			(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
	// 				.meta.logMessages
	// 		);
	// 	} catch (e) {
	// 		console.error(e);
	// 		assert(false);
	// 	}

	// 	const spotMarket0 = clearingHouse.getspotMarketAccount(marketIndex);
	// 	assert(spotMarket0.revenuePool.balance.eq(ZERO));
	// 	assert(spotMarket0.totalIfShares.eq(ZERO));
	// });
});
