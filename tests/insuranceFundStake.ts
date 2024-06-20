import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	OracleGuardRails,
	TestClient,
	User,
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
	convertToNumber,
	AMM_RESERVE_PRECISION,
	unstakeSharesToAmount,
	MarketStatus,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	setFeedPrice,
	sleep,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
} from './testHelpers';
import {
	ContractTier,
	PERCENTAGE_PRECISION,
	UserStatus,
} from '../sdk';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper, asBN } from '../sdk/src/bankrunConnection';

describe('insurance fund stake', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;

	const usdcAmount = new BN(1000000 * 10 ** 6); //1M

	let secondUserDriftClient: TestClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;

	let driftClientUser: User;

	const solAmount = new BN(10000 * 10 ** 9);

	before(async () => {
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram,
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 22500); // a future we all need to believe in

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await driftClient.initializePerpMarket(
			0,
			solOracle,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION,
			periodicity,
			new BN(22500 * PEG_PRECISION.toNumber()),
			undefined,
			ContractTier.A
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await driftClient.updatePerpMarketBaseSpread(0, 2000);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		const subAccountId = 0;
		const name = 'BIGZ';
		await driftClient.initializeUserAccount(subAccountId, name);
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await secondUserDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
		await driftClientUser.unsubscribe();
	});


	it('initialize if stake', async () => {
		const marketIndex = 0;
		await driftClient.initializeInsuranceFundStake(marketIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === marketIndex);
		assert(ifStakeAccount.authority.equals(bankrunContextWrapper.provider.wallet.publicKey));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.numberOfSubAccounts === 1);
		assert(userStats.ifStakedQuoteAssetAmount.eq(ZERO));
	});

	it('user if stake', async () => {
		const marketIndex = 0;
		const spotMarketBefore = driftClient.getSpotMarketAccount(marketIndex);
		// console.log(spotMarketBefore);
		console.log(
			'spotMarketBefore.totalIfShares:',
			spotMarketBefore.insuranceFund.totalShares.toString()
		);

		try {
			const txSig = await driftClient.addInsuranceFundStake({
				marketIndex: marketIndex,
				amount: usdcAmount,
				collateralAccountPublicKey: userUSDCAccount.publicKey,
			});
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		console.log(
			'spotMarket0.insurance.totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		// console.log(spotMarket0);

		assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount));

		const userStats = driftClient.getUserStats().getAccount();
		console.log(userStats);
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount));
	});

	it('user request if unstake (half)', async () => {
		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));

		const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);

		const insuranceVaultAmountBefore = (await bankrunContextWrapper.connection.getTokenAccount(spotMarket0Before.insuranceFund.vault)).amount;

		const amountFromShare = unstakeSharesToAmount(
			nShares,
			spotMarket0Before.insuranceFund.totalShares,
			new BN(Number(insuranceVaultAmountBefore))
		);

		console.log(amountFromShare.toString());

		try {
			const txSig = await driftClient.requestRemoveInsuranceFundStake(
				marketIndex,
				amountFromShare
			);
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
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
		await driftClient.updateInsuranceFundUnstakingPeriod(
			marketIndex,
			new BN(1)
		);
		await sleep(1000);

		const txSig = await driftClient.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		console.log(
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString()
		);

		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount.div(new BN(2))));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount.div(new BN(2))));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const balance = (await bankrunContextWrapper.connection.getAccountInfo(userUSDCAccount.publicKey)).lamports;
		console.log('sol balance:', balance.toString());
		const usdcbalance = (await bankrunContextWrapper.connection.getTokenAccount(userUSDCAccount.publicKey)).amount;
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance.toString() == '500000000000');

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));
	});

	it('user request if unstake with escrow period (last half)', async () => {
		const txSig = await driftClient.updateInsuranceFundUnstakingPeriod(
			0,
			new BN(10)
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));
		const txSig2 = await driftClient.requestRemoveInsuranceFundStake(
			marketIndex,
			nShares
		);
		bankrunContextWrapper.connection.printTxLogs(txSig2);

		try {
			const txSig3 = await driftClient.removeInsuranceFundStake(
				marketIndex,
				userUSDCAccount.publicKey
			);
			bankrunContextWrapper.connection.printTxLogs(txSig3);
			assert(false); // todo
		} catch (e) {
			console.error(e);
		}

		await driftClient.fetchAccounts();

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceFund.unstakingPeriod.eq(new BN(10)));
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount.div(new BN(2))));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.gt(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});

	it('user if unstake with escrow period (last half)', async () => {
		const marketIndex = 0;

		try {
			await driftClient.updateSpotMarketIfFactor(
				0,
				new BN(90000),
				new BN(100000)
			);
		} catch (e) {
			console.log('cant set reserve factor');
			console.error(e);
			assert(false);
		}

		const spotMarket0Pre = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0Pre.insuranceFund.unstakingPeriod.eq(new BN(10)));

		await bankrunContextWrapper.moveTimeForward(10);

		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await driftClient.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		console.log(
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString()
		);

		assert(spotMarket0.insuranceFund.totalShares.eq(ZERO));
		assert(spotMarket0.insuranceFund.userShares.eq(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(ZERO));

		const usdcbalance = (await bankrunContextWrapper.connection.getTokenAccount(userUSDCAccount.publicKey)).amount;
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance.toString() == '999999999999');
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
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			bulkAccountLoader
		);

		const marketIndex = 1;
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const spotMarket = await driftClient.getSpotMarketAccount(marketIndex);
		console.log(spotMarket.depositBalance.toString());
		// assert(spotMarket.depositBalance.eq('10000000000'));

		// const vaultAmount = new BN(
		// 	(
		// 		await provider.connection.getTokenAccountBalance(spotMarket.vault)
		// 	).value.amount
		// );
		const vaultAmount = (await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)).amount;
		assert(asBN(vaultAmount).eq(solAmount));

		const expectedBalance = getBalance(
			solAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const userspotMarketBalance =
			secondUserDriftClient.getUserAccount().spotPositions[1];
		assert(isVariant(userspotMarketBalance.balanceType, 'deposit'));
		assert(userspotMarketBalance.scaledBalance.eq(expectedBalance));
	});

	it('Second User Withdraw First half USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
		);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		const spotMarket = await driftClient.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(500000000000001);
		console.log(
			'spotMarket.borrowBalance:',
			spotMarket.borrowBalance.toString()
		);
		assert(spotMarket.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)).amount);
		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const userspotMarketBalance =
			secondUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(userspotMarketBalance.balanceType, 'borrow'));
		assert(userspotMarketBalance.scaledBalance.eq(expectedBalance));

		const actualAmountWithdrawn = asBN((await bankrunContextWrapper.connection.getTokenAccount(secondUserDriftClientUSDCAccount)).amount);
		assert(withdrawAmount.eq(actualAmountWithdrawn));
	});

	it('if pool revenue from borrows', async () => {
		let spotMarket = driftClient.getSpotMarketAccount(0);

		// await mintToInsuranceFund(
		// 	spotMarket.insurance.vault,
		// 	usdcMint,
		// 	new BN(80085).mul(QUOTE_PRECISION),
		// 	provider
		// );

		const ifPoolBalance = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		assert(spotMarket.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		await driftClient.updateSpotMarketCumulativeInterest(0);

		await driftClient.fetchAccounts();
		spotMarket = driftClient.getSpotMarketAccount(0);

		console.log(
			'cumulativeBorrowInterest:',
			spotMarket.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarket.cumulativeDepositInterest.toString()
		);
		const ifPoolBalanceAfterUpdate = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterUpdate.gt(new BN(0)));
		assert(spotMarket.cumulativeBorrowInterest.gt(SPOT_MARKET_RATE_PRECISION));
		assert(spotMarket.cumulativeDepositInterest.gt(SPOT_MARKET_RATE_PRECISION));

		const insuranceVaultAmountBefore = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket.insuranceFund.vault)).amount);
		console.log('insuranceVaultAmount:', insuranceVaultAmountBefore.toString());
		assert(insuranceVaultAmountBefore.eq(ONE));

		await driftClient.updateSpotMarketRevenueSettlePeriod(0, ONE);

		try {
			const txSig = await driftClient.settleRevenueToInsuranceFund(0);
			bankrunContextWrapper.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const insuranceVaultAmount = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket.insuranceFund.vault)).amount);
		console.log(
			'insuranceVaultAmount:',
			insuranceVaultAmountBefore.toString(),
			'->',
			insuranceVaultAmount.toString()
		);
		assert(insuranceVaultAmount.gt(ONE));

		await driftClient.fetchAccounts();
		spotMarket = driftClient.getSpotMarketAccount(0);
		const ifPoolBalanceAfterSettle = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterSettle.eq(new BN(0)));
	});

	it('no user -> user stake when there is a vault balance', async () => {
		const marketIndex = 0;
		const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket0Before.insuranceFund.vault)).amount);
		assert(spotMarket0Before.revenuePool.scaledBalance.eq(ZERO));

		assert(spotMarket0Before.insuranceFund.userShares.eq(ZERO));
		assert(spotMarket0Before.insuranceFund.totalShares.eq(ZERO));

		const usdcbalance = asBN((await bankrunContextWrapper.connection.getTokenAccount(userUSDCAccount.publicKey)).amount);
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance.toString() == '999999999999');

		try {
			const txSig = await driftClient.addInsuranceFundStake({
				marketIndex,
				amount: new BN(usdcbalance),
				collateralAccountPublicKey: userUSDCAccount.publicKey,
			});
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
		const insuranceVaultAmountAfter = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket0.insuranceFund.vault)).amount);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString(),
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.gt(usdcAmount));
		assert(spotMarket0.insuranceFund.totalShares.gt(new BN('1000000004698')));
		// totalIfShares lower bound, kinda random basd on timestamps

		assert(
			spotMarket0.insuranceFund.userShares.eq(new BN(usdcbalance))
		);

		const userStats = driftClient.getUserStats().getAccount();
		assert(
			userStats.ifStakedQuoteAssetAmount.eq(new BN(usdcbalance))
		);
	});

	it('user stake misses out on gains during escrow period after cancel', async () => {
		const marketIndex = 0;
		const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket0Before.insuranceFund.vault)).amount);
		assert(spotMarket0Before.revenuePool.scaledBalance.eq(ZERO));

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
			driftClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		const amountFromShare = unstakeSharesToAmount(
			ifStakeAccount.ifShares.div(new BN(10)),
			spotMarket0Before.insuranceFund.totalShares,
			insuranceVaultAmountBefore
		);

		await driftClient.requestRemoveInsuranceFundStake(
			marketIndex,
			amountFromShare
		);

		console.log('letting interest accum (2s)');
		await sleep(2000);
		await driftClient.updateSpotMarketCumulativeInterest(0);
		await driftClient.fetchAccounts();
		const spotMarketIUpdate = await driftClient.getSpotMarketAccount(
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

		console.log(spotMarketIUpdate.revenuePool.scaledBalance.toString());
		assert(spotMarketIUpdate.revenuePool.scaledBalance.gt(ZERO));

		try {
			const txSig = await driftClient.settleRevenueToInsuranceFund(marketIndex);
			bankrunContextWrapper.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const insuranceVaultAmountAfter = asBN((await bankrunContextWrapper.connection.getTokenAccount(spotMarket0Before.insuranceFund.vault)).amount);

		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		const txSig = await driftClient.cancelRequestRemoveInsuranceFundStake(
			marketIndex
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const ifStakeAccountAfter =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		const userStats = driftClient.getUserStats().getAccount();

		console.log(
			'ifshares:',
			ifStakeAccount.ifShares.toString(),
			'->',
			ifStakeAccountAfter.ifShares.toString(),
			'(quoteAssetInsuranceFundStake=',
			userStats.ifStakedQuoteAssetAmount.toString(),
			')'
		);

		assert(ifStakeAccountAfter.ifShares.lt(ifStakeAccount.ifShares));

		// the user should have slightly less quote staked than the total quote in if
		assert(
			insuranceVaultAmountAfter
				.sub(userStats.ifStakedQuoteAssetAmount)
				.lt(QUOTE_PRECISION)
		);
	});

	it('liquidate borrow (w/ IF revenue)', async () => {
		const spotMarketBefore = driftClient.getSpotMarketAccount(0);

		const revPoolBalance = getTokenAmount(
			spotMarketBefore.revenuePool.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);
		console.log('revPoolBalance:', revPoolBalance.toString());

		assert(spotMarketBefore.borrowBalance.gt(ZERO));
		assert(revPoolBalance.gt(new BN(0))); // should be a little residual left in rev pool
		assert(revPoolBalance.lt(QUOTE_PRECISION));

		driftClientUser = new User({
			driftClient: secondUserDriftClient,
			userAccountPublicKey:
				await secondUserDriftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
				},
		});
		await driftClientUser.subscribe();

		const prevTC = driftClientUser.getTotalCollateral();
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: PERCENTAGE_PRECISION,
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION,
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(100000),
			},
		};

		await driftClient.updateLiquidationDuration(1);
		await driftClient.updateOracleGuardRails(oracleGuardRails);
		await setFeedPriceNoProgram(bankrunContextWrapper, 22500 / 10000, solOracle); // down 99.99%
		await sleep(2000);

		const state = await driftClient.getStateAccount();
		console.log('state.liquidationDuration', state.liquidationDuration);
		assert(state.liquidationDuration > 0);

		await driftClientUser.fetchAccounts();

		const newTC = driftClientUser.getTotalCollateral();
		console.log(
			"Borrower's TotalCollateral: ",
			convertToNumber(prevTC, QUOTE_PRECISION),
			'->',
			convertToNumber(newTC, QUOTE_PRECISION)
		);
		assert(!prevTC.eq(newTC));

		assert(driftClientUser.canBeLiquidated());

		const beforecbb0 = driftClient.getUserAccount().spotPositions[0];
		const beforecbb1 = driftClient.getUserAccount().spotPositions[1];

		const beforeLiquiderUSDCDeposit = getTokenAmount(
			beforecbb0.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		const beforeLiquiderSOLDeposit = getTokenAmount(
			beforecbb1.scaledBalance,
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

		const beforebb0 = secondUserDriftClient.getUserAccount().spotPositions[0];
		const beforebb1 = secondUserDriftClient.getUserAccount().spotPositions[1];

		const usdcDepositsBefore = getTokenAmount(
			spotMarketBefore.depositBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		const beforeLiquiteeUSDCBorrow = getTokenAmount(
			beforebb0.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.BORROW
		);

		const beforeLiquiteeSOLDeposit = getTokenAmount(
			beforebb1.scaledBalance,
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

		const txSig = await driftClient.liquidateSpot(
			await secondUserDriftClient.getUserAccountPublicKey(),
			secondUserDriftClient.getUserAccount(),
			1,
			0,
			new BN(6 * 10 ** 8)
		);

		const computeUnits = bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await secondUserDriftClient.fetchAccounts();

		const spotMarket = driftClient.getSpotMarketAccount(0);

		const cbb0 = driftClient.getUserAccount().spotPositions[0];
		const cbb1 = driftClient.getUserAccount().spotPositions[1];

		const afterLiquiderUSDCDeposit = getTokenAmount(
			cbb0.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		const afterLiquiderSOLDeposit = getTokenAmount(
			cbb1.scaledBalance,
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

		const bb0 = secondUserDriftClient.getUserAccount().spotPositions[0];
		const bb1 = secondUserDriftClient.getUserAccount().spotPositions[1];

		const afterLiquiteeUSDCBorrow = getTokenAmount(
			bb0.scaledBalance,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const afterLiquiteeSOLDeposit = getTokenAmount(
			bb1.scaledBalance,
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
		// assert(afterLiquiteeUSDCBorrow.gte(new BN('499406444150')));
		// assert(afterLiquiteeSOLDeposit.gte(new BN('9733337361')));

		// console.log(
		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[0].scaledBalance.toString(),

		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[0].marketIndex.toString(),
		// 	secondUserDriftClient.getUserAccount().spotPositions[0].balanceType
		// );

		// console.log(
		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[1].scaledBalance.toString(),

		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[1].marketIndex.toString(),
		// 	secondUserDriftClient.getUserAccount().spotPositions[1].balanceType
		// );

		assert(
			secondUserDriftClient.getUserAccount().status ===
				UserStatus.BEING_LIQUIDATED
		);

		assert(
			secondUserDriftClient.getUserAccount().status !== UserStatus.BANKRUPT
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateSpot'));
		assert(liquidationRecord.liquidateSpot.liabilityMarketIndex === 0);
		console.log(liquidationRecord.liquidateSpot.liabilityTransfer.toString());
		assert(
			liquidationRecord.liquidateSpot.liabilityTransfer.eq(new BN(600000000))
		);
		console.log(liquidationRecord.liquidateSpot.ifFee.toString());
		console.log(spotMarketBefore.liquidatorFee.toString());
		console.log(spotMarketBefore.ifLiquidationFee.toString());
		console.log(
			liquidationRecord.liquidateSpot.liabilityTransfer
				.div(new BN(100))
				.toString()
		);

		// if liquidator fee is non-zero, it should be equal to that
		assert(
			liquidationRecord.liquidateSpot.ifFee.eq(
				new BN(spotMarketBefore.liquidatorFee)
			)
		);

		// but it is zero
		assert(liquidationRecord.liquidateSpot.ifFee.eq(ZERO));

		const ifPoolBalanceAfter = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		console.log('ifPoolBalance: 0 ->', ifPoolBalanceAfter.toString());

		assert(ifPoolBalanceAfter.gte(new BN('8840')));
		assert(ifPoolBalanceAfter.lte(new BN('30080')));

		// assert(ifPoolBalanceAfter.gte(new BN('6004698'))); // before IF fee change

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

		await driftClientUser.unsubscribe();

		// TODO: resolve any issues in liq borrow before adding asserts in test here

		// assert(usdcBefore.eq(usdcAfter));
	});

	// it('settle spotMarket to insurance vault', async () => {
	// 	const marketIndex = new BN(0);

	// 	const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);

	// 	const insuranceVaultAmountBefore = new BN(
	// 		(
	// 			await provider.connection.getTokenAccountBalance(
	// 				spotMarket0Before.insurance.vault
	// 			)
	// 		).value.amount
	// 	);

	// 	assert(insuranceVaultAmountBefore.gt(ZERO));
	// 	assert(spotMarket0Before.revenuePool.scaledBalance.gt(ZERO));

	// 	console.log(
	// 		'userIfShares:',
	// 		spotMarket0Before.insurance.userIfShares.toString(),
	// 		'totalIfShares:',
	// 		spotMarket0Before.insurance.totalIfShares.toString()
	// 	);
	// 	assert(spotMarket0Before.insurance.userIfShares.eq(ZERO));
	// 	assert(spotMarket0Before.insurance.totalIfShares.eq(ZERO)); // 0_od

	// 	try {
	// 		const txSig = await driftClient.settleRevenueToInsuranceFund(marketIndex);
	// 		console.log(
	// 			'tx logs',
	// 			(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
	// 				.meta.logMessages
	// 		);
	// 	} catch (e) {
	// 		console.error(e);
	// 		assert(false);
	// 	}

	// 	const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
	// 	assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
	// 	assert(spotMarket0.insurance.totalIfShares.eq(ZERO));
	// });
});
