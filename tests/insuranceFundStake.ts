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
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
} from './testHelpers';
import { ContractTier, PERCENTAGE_PRECISION, UserStatus } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import {
	BankrunContextWrapper,
	asBN,
} from '../sdk/src/bankrun/bankrunConnection';

describe('insurance fund stake', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;

	// sized so the half-deposit borrow ($5k) stays under the program's $10k
	// withdraw guard threshold notional cap
	const usdcAmount = new BN(10000 * 10 ** 6); //10k

	let secondUserVelocityClient: TestClient;
	let secondUserVelocityClientWSOLAccount: PublicKey;
	let secondUserVelocityClientUSDCAccount: PublicKey;

	let velocityClientUser: User;

	const solAmount = new BN(100 * 10 ** 9);

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
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			22500,
			-7,
			undefined,
			10000
		); // a future we all need to believe in

		velocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await velocityClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await velocityClient.initializePerpMarket(
			0,
			solOracle,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION,
			periodicity,
			new BN(22500 * PEG_PRECISION.toNumber()),
			undefined,
			ContractTier.A
		);
		await velocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await velocityClient.updatePerpMarketBaseSpread(0, 2000);
		await velocityClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		const subAccountId = 0;
		const name = 'BIGZ';
		await velocityClient.initializeUserAccount(subAccountId, name);
		await velocityClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await secondUserVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
		await velocityClientUser.unsubscribe();
	});

	it('initialize if stake', async () => {
		const marketIndex = 0;
		await velocityClient.initializeInsuranceFundStake(marketIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === marketIndex);
		assert(
			ifStakeAccount.authority.equals(
				bankrunContextWrapper.provider.wallet.publicKey
			)
		);

		const userStats = velocityClient.getUserStats().getAccount();
		assert(userStats.numberOfSubAccounts === 1);
		assert(userStats.ifStakedQuoteAssetAmount.eq(ZERO));
	});

	it('user if stake', async () => {
		const marketIndex = 0;
		const spotMarketBefore = velocityClient.getSpotMarketAccount(marketIndex);
		// console.log(spotMarketBefore);
		console.log(
			'spotMarketBefore.totalIfShares:',
			spotMarketBefore.insuranceFund.totalShares.toString()
		);

		try {
			const txSig = await velocityClient.addInsuranceFundStake({
				marketIndex: marketIndex,
				amount: usdcAmount,
				collateralAccountPublicKey: userUSDCAccount.publicKey,
			});
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
		console.log(
			'spotMarket0.insurance.totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		// console.log(spotMarket0);

		assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount));

		const userStats = velocityClient.getUserStats().getAccount();
		console.log(userStats);
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount));
	});

	it('user request if unstake (half)', async () => {
		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));

		const spotMarket0Before = velocityClient.getSpotMarketAccount(marketIndex);

		const insuranceVaultAmountBefore = (
			await bankrunContextWrapper.connection.getTokenAccount(
				spotMarket0Before.insuranceFund.vault
			)
		).amount;

		const amountFromShare = unstakeSharesToAmount(
			nShares,
			spotMarket0Before.insuranceFund.totalShares,
			new BN(Number(insuranceVaultAmountBefore))
		);

		console.log(amountFromShare.toString());

		try {
			const txSig = await velocityClient.requestRemoveInsuranceFundStake(
				marketIndex,
				amountFromShare
			);
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount));

		const userStats = velocityClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
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
		await velocityClient.updateInsuranceFundUnstakingPeriod(
			marketIndex,
			new BN(1)
		);
		await bulkAccountLoader.load();

		const txSig = await velocityClient.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
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

		const userStats = velocityClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount.div(new BN(2))));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const balance = (
			await bankrunContextWrapper.connection.getAccountInfo(
				userUSDCAccount.publicKey
			)
		).lamports;
		console.log('sol balance:', balance.toString());
		const usdcbalance = (
			await bankrunContextWrapper.connection.getTokenAccount(
				userUSDCAccount.publicKey
			)
		).amount;
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance.toString() == '5000000000');

		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));
	});

	it('user request if unstake with escrow period (last half)', async () => {
		const txSig = await velocityClient.updateInsuranceFundUnstakingPeriod(
			0,
			new BN(10)
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));
		const txSig2 = await velocityClient.requestRemoveInsuranceFundStake(
			marketIndex,
			nShares
		);
		bankrunContextWrapper.connection.printTxLogs(txSig2);

		try {
			const txSig3 = await velocityClient.removeInsuranceFundStake(
				marketIndex,
				userUSDCAccount.publicKey
			);
			bankrunContextWrapper.connection.printTxLogs(txSig3);
			assert(false); // todo
		} catch (e) {
			console.error(e);
		}

		await velocityClient.fetchAccounts();

		const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceFund.unstakingPeriod.eq(new BN(10)));
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount.div(new BN(2))));

		const userStats = velocityClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.gt(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});

	it('user if unstake with escrow period (last half)', async () => {
		const marketIndex = 0;

		try {
			// 10% of lending gains to the (100% staker-owned) insurance fund
			await velocityClient.updateSpotMarketIfFactor(0, 100000, 0);
		} catch (e) {
			console.log('cant set reserve factor');
			console.error(e);
			assert(false);
		}

		const spotMarket0Pre = velocityClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0Pre.insuranceFund.unstakingPeriod.eq(new BN(10)));

		await bankrunContextWrapper.moveTimeForward(10);

		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await velocityClient.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
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
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));

		const userStats = velocityClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(ZERO));

		const usdcbalance = (
			await bankrunContextWrapper.connection.getTokenAccount(
				userUSDCAccount.publicKey
			)
		).amount;
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance.toString() == '9999999999');
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
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);

		const marketIndex = 1;
		const txSig = await secondUserVelocityClient.deposit(
			solAmount,
			marketIndex,
			secondUserVelocityClientWSOLAccount
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const spotMarket = await velocityClient.getSpotMarketAccount(marketIndex);
		console.log(spotMarket.depositBalance.toString());
		// assert(spotMarket.depositBalance.eq('10000000000'));

		// const vaultAmount = new BN(
		// 	(
		// 		await provider.connection.getTokenAccountBalance(spotMarket.vault)
		// 	).value.amount
		// );
		const vaultAmount = (
			await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault)
		).amount;
		assert(asBN(vaultAmount).eq(solAmount));

		const expectedBalance = getBalance(
			solAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const userspotMarketBalance =
			secondUserVelocityClient.getUserAccount().spotPositions[1];
		assert(isVariant(userspotMarketBalance.balanceType, 'deposit'));
		assert(userspotMarketBalance.scaledBalance.eq(expectedBalance));
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

		await velocityClient.fetchAccounts();
		const spotMarket = await velocityClient.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(5000000000001);
		console.log(
			'spotMarket.borrowBalance:',
			spotMarket.borrowBalance.toString()
		);
		assert(spotMarket.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = asBN(
			(await bankrunContextWrapper.connection.getTokenAccount(spotMarket.vault))
				.amount
		);
		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const userspotMarketBalance =
			secondUserVelocityClient.getUserAccount().spotPositions[0];
		assert(isVariant(userspotMarketBalance.balanceType, 'borrow'));
		assert(userspotMarketBalance.scaledBalance.eq(expectedBalance));

		const actualAmountWithdrawn = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					secondUserVelocityClientUSDCAccount
				)
			).amount
		);
		assert(withdrawAmount.eq(actualAmountWithdrawn));
	});

	it('if pool revenue from borrows', async () => {
		let spotMarket = velocityClient.getSpotMarketAccount(0);

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

		await velocityClient.updateSpotMarketCumulativeInterest(0);

		await velocityClient.fetchAccounts();
		spotMarket = velocityClient.getSpotMarketAccount(0);

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

		const insuranceVaultAmountBefore = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarket.insuranceFund.vault
				)
			).amount
		);
		console.log('insuranceVaultAmount:', insuranceVaultAmountBefore.toString());
		assert(insuranceVaultAmountBefore.eq(ONE));

		await velocityClient.updateSpotMarketRevenueSettlePeriod(0, ONE);

		try {
			const txSig = await velocityClient.settleRevenueToInsuranceFund(0);
			bankrunContextWrapper.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
		}

		const insuranceVaultAmount = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarket.insuranceFund.vault
				)
			).amount
		);
		console.log(
			'insuranceVaultAmount:',
			insuranceVaultAmountBefore.toString(),
			'->',
			insuranceVaultAmount.toString()
		);
		assert(insuranceVaultAmount.gt(ONE));

		await velocityClient.fetchAccounts();
		spotMarket = velocityClient.getSpotMarketAccount(0);
		const ifPoolBalanceAfterSettle = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterSettle.eq(new BN(0)));
	});

	it('no user -> user stake when there is a vault balance', async () => {
		const marketIndex = 0;
		const spotMarket0Before = velocityClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarket0Before.insuranceFund.vault
				)
			).amount
		);
		assert(spotMarket0Before.revenuePool.scaledBalance.eq(ZERO));

		assert(spotMarket0Before.insuranceFund.userShares.eq(ZERO));
		// no-staker bootstrap: settling fees with zero shares seeds total_shares
		// 1:1 with the vault (permanent, non-withdrawable protocol ballast) so
		// the first staker mints at share price ~1 instead of zero shares
		assert(spotMarket0Before.insuranceFund.totalShares.gt(ZERO));
		assert(
			spotMarket0Before.insuranceFund.totalShares.lte(
				insuranceVaultAmountBefore
			)
		);

		const usdcbalance = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					userUSDCAccount.publicKey
				)
			).amount
		);
		console.log('usdc balance:', usdcbalance);
		assert(usdcbalance.toString() == '9999999999');

		try {
			const txSig = await velocityClient.addInsuranceFundStake({
				marketIndex,
				amount: new BN(usdcbalance),
				collateralAccountPublicKey: userUSDCAccount.publicKey,
			});
			bankrunContextWrapper.connection.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
		const insuranceVaultAmountAfter = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarket0.insuranceFund.vault
				)
			).amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString(),
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));

		// the staker mints against the bootstrap ballast at the prevailing share
		// price (>= 1, since the tiny ballast appreciates with every settle):
		// fewer shares than tokens staked is expected — what matters is that the
		// staker's redeemable VALUE matches what they put in
		const userShares = spotMarket0.insuranceFund.userShares;
		const totalShares = spotMarket0.insuranceFund.totalShares;
		assert(userShares.gt(ZERO));
		assert(userShares.lte(new BN(usdcbalance)));
		assert(totalShares.gt(userShares)); // ballast shares remain

		const userValue = userShares
			.mul(insuranceVaultAmountAfter)
			.div(totalShares);
		// redeemable value within 0.01% of the staked amount (rounding only)
		assert(userValue.gte(new BN(usdcbalance).muln(9999).divn(10000)));
		assert(userValue.lte(new BN(usdcbalance)));

		const userStats = velocityClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.gt(ZERO));
		assert(
			userStats.ifStakedQuoteAssetAmount.gte(
				new BN(usdcbalance).muln(99).divn(100)
			)
		);
	});

	it('user stake misses out on gains during escrow period after cancel', async () => {
		const marketIndex = 0;
		const spotMarket0Before = velocityClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarket0Before.insuranceFund.vault
				)
			).amount
		);
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
			velocityClient.program.programId,
			bankrunContextWrapper.provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		const amountFromShare = unstakeSharesToAmount(
			ifStakeAccount.ifShares.div(new BN(10)),
			spotMarket0Before.insuranceFund.totalShares,
			insuranceVaultAmountBefore
		);

		await velocityClient.requestRemoveInsuranceFundStake(
			marketIndex,
			amountFromShare
		);

		console.log('letting interest accum (2s + 200s warp)');
		await bulkAccountLoader.load();
		// warp the chain clock so the smaller borrow (scaled down for the $10k
		// withdraw guard cap) still accrues enough interest to rebase if shares
		await bankrunContextWrapper.moveTimeForward(200);
		await velocityClient.updateSpotMarketCumulativeInterest(0);
		await velocityClient.fetchAccounts();
		const spotMarketIUpdate = await velocityClient.getSpotMarketAccount(
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
			const txSig = await velocityClient.settleRevenueToInsuranceFund(
				marketIndex
			);
			bankrunContextWrapper.printTxLogs(txSig);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const insuranceVaultAmountAfter = asBN(
			(
				await bankrunContextWrapper.connection.getTokenAccount(
					spotMarket0Before.insuranceFund.vault
				)
			).amount
		);

		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		const txSig = await velocityClient.cancelRequestRemoveInsuranceFundStake(
			marketIndex
		);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		const ifStakeAccountAfter =
			(await velocityClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		const userStats = velocityClient.getUserStats().getAccount();

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
		const spotMarketBefore = velocityClient.getSpotMarketAccount(0);

		const revPoolBalance = getTokenAmount(
			spotMarketBefore.revenuePool.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);
		console.log('revPoolBalance:', revPoolBalance.toString());

		assert(spotMarketBefore.borrowBalance.gt(ZERO));
		assert(revPoolBalance.gt(new BN(0))); // should be a little residual left in rev pool
		assert(revPoolBalance.lt(QUOTE_PRECISION));

		velocityClientUser = new User({
			velocityClient: secondUserVelocityClient,
			userAccountPublicKey:
				await secondUserVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();

		const prevTC = velocityClientUser.getTotalCollateral();
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

		await velocityClient.updateLiquidationDuration(1);
		await velocityClient.updateOracleGuardRails(oracleGuardRails);
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			22500 / 10000,
			solOracle,
			-50
		); // down 99.99%
		await bulkAccountLoader.load();

		const state = await velocityClient.getStateAccount();
		console.log('state.liquidationDuration', state.liquidationDuration);
		assert(state.liquidationDuration > 0);

		await velocityClientUser.fetchAccounts();

		const newTC = velocityClientUser.getTotalCollateral();
		console.log(
			"Borrower's TotalCollateral: ",
			convertToNumber(prevTC, QUOTE_PRECISION),
			'->',
			convertToNumber(newTC, QUOTE_PRECISION)
		);
		assert(!prevTC.eq(newTC));

		assert(velocityClientUser.canBeLiquidated());

		const beforecbb0 = velocityClient.getUserAccount().spotPositions[0];
		const beforecbb1 = velocityClient.getUserAccount().spotPositions[1];

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

		const beforebb0 =
			secondUserVelocityClient.getUserAccount().spotPositions[0];
		const beforebb1 =
			secondUserVelocityClient.getUserAccount().spotPositions[1];

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

		assert(beforeLiquiderUSDCDeposit.gt(new BN('10000000660')));
		assert(beforeLiquiderSOLDeposit.eq(new BN('0')));
		assert(beforeLiquiteeUSDCBorrow.gt(new BN('5000000330')));
		assert(beforeLiquiteeSOLDeposit.gt(new BN('100000009')));

		const txSig = await velocityClient.liquidateSpot(
			await secondUserVelocityClient.getUserAccountPublicKey(),
			secondUserVelocityClient.getUserAccount(),
			1,
			0,
			new BN(6 * 10 ** 6)
		);

		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.printTxLogs(txSig);

		await velocityClient.fetchAccounts();
		await secondUserVelocityClient.fetchAccounts();

		const spotMarket = velocityClient.getSpotMarketAccount(0);

		const cbb0 = velocityClient.getUserAccount().spotPositions[0];
		const cbb1 = velocityClient.getUserAccount().spotPositions[1];

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

		const bb0 = secondUserVelocityClient.getUserAccount().spotPositions[0];
		const bb1 = secondUserVelocityClient.getUserAccount().spotPositions[1];

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

		assert(afterLiquiderUSDCDeposit.gt(new BN('9994000658')));
		assert(afterLiquiderSOLDeposit.gt(new BN('2666600')));
		console.log(afterLiquiteeUSDCBorrow.toString());
		console.log(afterLiquiteeSOLDeposit.toString());
		// assert(afterLiquiteeUSDCBorrow.gte(new BN('499406444150')));
		// assert(afterLiquiteeSOLDeposit.gte(new BN('9733337361')));

		// console.log(
		// 	secondUserVelocityClient
		// 		.getUserAccount()
		// 		.spotPositions[0].scaledBalance.toString(),

		// 	secondUserVelocityClient
		// 		.getUserAccount()
		// 		.spotPositions[0].marketIndex.toString(),
		// 	secondUserVelocityClient.getUserAccount().spotPositions[0].balanceType
		// );

		// console.log(
		// 	secondUserVelocityClient
		// 		.getUserAccount()
		// 		.spotPositions[1].scaledBalance.toString(),

		// 	secondUserVelocityClient
		// 		.getUserAccount()
		// 		.spotPositions[1].marketIndex.toString(),
		// 	secondUserVelocityClient.getUserAccount().spotPositions[1].balanceType
		// );

		assert(
			secondUserVelocityClient.getUserAccount().status ===
				UserStatus.BEING_LIQUIDATED
		);

		assert(
			secondUserVelocityClient.getUserAccount().status !== UserStatus.BANKRUPT
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateSpot'));
		assert(liquidationRecord.liquidateSpot.liabilityMarketIndex === 0);
		console.log(liquidationRecord.liquidateSpot.liabilityTransfer.toString());
		assert(
			liquidationRecord.liquidateSpot.liabilityTransfer.eq(new BN(6000000))
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

		assert(ifPoolBalanceAfter.gte(new BN('88')));
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

		await velocityClientUser.unsubscribe();

		// TODO: resolve any issues in liq borrow before adding asserts in test here

		// assert(usdcBefore.eq(usdcAfter));
	});

	// it('settle spotMarket to insurance vault', async () => {
	// 	const marketIndex = new BN(0);

	// 	const spotMarket0Before = velocityClient.getSpotMarketAccount(marketIndex);

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
	// 		const txSig = await velocityClient.settleRevenueToInsuranceFund(marketIndex);
	// 		console.log(
	// 			'tx logs',
	// 			(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
	// 				.meta.logMessages
	// 		);
	// 	} catch (e) {
	// 		console.error(e);
	// 		assert(false);
	// 	}

	// 	const spotMarket0 = velocityClient.getSpotMarketAccount(marketIndex);
	// 	assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
	// 	assert(spotMarket0.insurance.totalIfShares.eq(ZERO));
	// });
});
