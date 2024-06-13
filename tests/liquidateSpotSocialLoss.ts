import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	OracleSource,
	ZERO,
	EventSubscriber,
	PRICE_PRECISION,
	getTokenAmount,
	SpotBalanceType,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
	fundWsolTokenAccountForUser,
} from './testHelpers';
import {
	isVariant,
	UserStatus,
	PERCENTAGE_PRECISION,
} from '../sdk';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('liquidate spot w/ social loss', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorDriftClient: TestClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);
	let liquidatorKeypair: Keypair;

	let _throwaway: PublicKey;
	
	before(async () => {
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);		
		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);
		userWSOLAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			ZERO
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection,
			chProgram,
		);

		eventSubscriber.initializeForTests();

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		const oracleGuardrails = await driftClient.getStateAccount()
			.oracleGuardRails;
		oracleGuardrails.priceDivergence.oracleTwap5MinPercentDivergence = new BN(
			100
		).mul(PERCENTAGE_PRECISION);
		await driftClient.updateOracleGuardRails(oracleGuardrails);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const solAmount = new BN(10 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount, _throwaway, liquidatorKeypair] =
			await createUserWithUSDCAndWSOLAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
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

		await fundWsolTokenAccountForUser(bankrunContextWrapper, liquidatorKeypair, solAmount.mul(new BN(1_000)));

		await liquidatorDriftClient.deposit(
			solAmount,
			marketIndex,
			liquidatorDriftClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await driftClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	it('liquidate', async () => {
		await setFeedPriceNoProgram(bankrunContextWrapper, 200, solOracle);
		const spotMarketBefore = driftClient.getSpotMarketAccount(0);
		const spotMarket1Before = driftClient.getSpotMarketAccount(1);

		const txSig = await liquidatorDriftClient.liquidateSpot(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			1,
			new BN(6 * 10 ** 8)
		);

		await eventSubscriber.registerSig(txSig);

		const computeUnits = bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		console.log(driftClient.getUserAccount().status);
		// assert(driftClient.getUserAccount().isBeingLiquidated);
		assert(driftClient.getUserAccount().status === UserStatus.BANKRUPT);

		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		// assert(
		// 	driftClient.getUserAccount().spotPositions[0].scaledBalance.eq(ZERO)
		// );

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateSpot'));
		assert(liquidationRecord.liquidateSpot.assetPrice.eq(PRICE_PRECISION));
		assert(liquidationRecord.liquidateSpot.assetMarketIndex === 0);
		assert(liquidationRecord.liquidateSpot.assetTransfer.eq(new BN(100000000)));
		assert(
			liquidationRecord.liquidateSpot.liabilityPrice.eq(
				new BN(200).mul(PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateSpot.liabilityMarketIndex === 1);
		assert(
			liquidationRecord.liquidateSpot.liabilityTransfer.eq(new BN(500000000))
		);
		console.log(liquidationRecord.liquidateSpot.ifFee.toString());
		console.log(spotMarketBefore.liquidatorFee.toString());
		console.log(spotMarketBefore.ifLiquidationFee.toString());
		console.log(
			liquidationRecord.liquidateSpot.liabilityTransfer
				.div(new BN(100))
				.toString()
		);

		// if liq fee is 0 since user is bankrupt
		assert(liquidationRecord.liquidateSpot.ifFee.eq(new BN(0)));

		// if liquidator fee is non-zero, it should be equal to that
		assert(
			liquidationRecord.liquidateSpot.ifFee.eq(
				new BN(spotMarketBefore.liquidatorFee)
			)
		);

		// but it is zero
		assert(liquidationRecord.liquidateSpot.ifFee.eq(ZERO));

		assert(
			new BN(5000000).eq(
				liquidationRecord.liquidateSpot.liabilityTransfer.div(new BN(100))
			)
		);
		await driftClient.fetchAccounts();
		const spotMarket = driftClient.getSpotMarketAccount(0);
		const spotMarket1 = driftClient.getSpotMarketAccount(1);

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
			'usdc deposits in spotMarket:',
			getTokenAmount(
				spotMarketBefore.depositBalance,
				spotMarketBefore,
				SpotBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				spotMarket.depositBalance,
				spotMarket,
				SpotBalanceType.DEPOSIT
			).toString()
		);

		console.log(
			'sol borrows in spotMarket:',
			getTokenAmount(
				spotMarket1Before.borrowBalance,
				spotMarket1Before,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket1.borrowBalance,
				spotMarket1,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'sol deposits in spotMarket:',
			getTokenAmount(
				spotMarket1Before.depositBalance,
				spotMarket1Before,
				SpotBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				spotMarket1.depositBalance,
				spotMarket1,
				SpotBalanceType.DEPOSIT
			).toString()
		);

		const borrowDecrease = getTokenAmount(
			spotMarket1Before.borrowBalance,
			spotMarket1Before,
			SpotBalanceType.BORROW
		).sub(
			getTokenAmount(
				spotMarket1.borrowBalance,
				spotMarket1,
				SpotBalanceType.BORROW
			)
		);

		const depositAmountBefore = getTokenAmount(
			spotMarket1Before.depositBalance,
			spotMarket1Before,
			SpotBalanceType.DEPOSIT
		).sub(borrowDecrease);

		const currentDepositAmount = getTokenAmount(
			spotMarket1.depositBalance,
			spotMarket1,
			SpotBalanceType.DEPOSIT
		);

		const interestOfUpdate = currentDepositAmount.sub(depositAmountBefore);
		console.log('interestOfUpdate:', interestOfUpdate.toString());
		assert(interestOfUpdate.abs().lte(new BN(1)));
	});

	it('resolve bankruptcy', async () => {
		const spotMarketBefore = driftClient.getSpotMarketAccount(0);
		const spotMarket1Before = driftClient.getSpotMarketAccount(1);

		const spotMarketCumulativeDepositInterestBefore =
			driftClient.getSpotMarketAccount(1).cumulativeDepositInterest;

		const sig = await liquidatorDriftClient.resolveSpotBankruptcy(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			1
		);

		await eventSubscriber.registerSig(sig);

		await driftClient.fetchAccounts();

		assert(driftClient.getUserAccount().status === 0);

		// assert(!driftClient.getUserAccount().isBankrupt);
		// assert(
		// 	driftClient.getUserAccount().spotPositions[1].scaledBalance.eq(ZERO)
		// );

		const bankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(isVariant(bankruptcyRecord.liquidationType, 'spotBankruptcy'));
		console.log(bankruptcyRecord.spotBankruptcy);
		assert(bankruptcyRecord.spotBankruptcy.marketIndex === 1);
		console.log(bankruptcyRecord.spotBankruptcy.borrowAmount.toString());
		const spotMarket = driftClient.getSpotMarketAccount(1);
		assert(
			spotMarket.cumulativeDepositInterest.eq(
				spotMarketCumulativeDepositInterestBefore.sub(
					bankruptcyRecord.spotBankruptcy.cumulativeDepositInterestDelta
				)
			)
		);

		await driftClient.fetchAccounts();
		const spotMarket0 = driftClient.getSpotMarketAccount(0);
		const spotMarket1 = driftClient.getSpotMarketAccount(1);

		console.log(
			'usdc borrows in spotMarket:',
			getTokenAmount(
				spotMarketBefore.borrowBalance,
				spotMarketBefore,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket0.borrowBalance,
				spotMarket0,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'usdc deposits in spotMarket:',
			getTokenAmount(
				spotMarketBefore.depositBalance,
				spotMarketBefore,
				SpotBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				spotMarket0.depositBalance,
				spotMarket0,
				SpotBalanceType.DEPOSIT
			).toString()
		);

		console.log(
			'sol borrows in spotMarket:',
			getTokenAmount(
				spotMarket1Before.borrowBalance,
				spotMarket1Before,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket1.borrowBalance,
				spotMarket1,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'sol deposits in spotMarket:',
			getTokenAmount(
				spotMarket1Before.depositBalance,
				spotMarket1Before,
				SpotBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				spotMarket1.depositBalance,
				spotMarket1,
				SpotBalanceType.DEPOSIT
			).toString()
		);

		const netBalance0Before = spotMarketBefore.depositBalance.sub(
			spotMarketBefore.borrowBalance
		);
		const netBalance0After = spotMarket0.depositBalance.sub(
			spotMarket0.borrowBalance
		);

		console.log(
			'netBalance usd:',
			netBalance0Before.toString(),
			'->',
			netBalance0After.toString()
		);

		console.log(
			'cumulative deposit interest usd:',
			spotMarketBefore.cumulativeDepositInterest.toString(),
			'->',
			spotMarket0.cumulativeDepositInterest.toString()
		);
		console.log(
			'cumulative borrow interest usd:',
			spotMarketBefore.cumulativeBorrowInterest.toString(),
			'->',
			spotMarket0.cumulativeBorrowInterest.toString()
		);

		assert(netBalance0Before.eq(netBalance0After));

		const netBalanceBefore = spotMarket1Before.depositBalance.sub(
			spotMarket1Before.borrowBalance
		);
		const netBalanceAfter = spotMarket1.depositBalance.sub(
			spotMarket1.borrowBalance
		);

		console.log(
			'netBalance sol:',
			netBalanceBefore.toString(),
			'->',
			netBalanceAfter.toString()
		);

		console.log(
			'cumulative deposit interest sol:',
			spotMarket1Before.cumulativeDepositInterest.toString(),
			'->',
			spotMarket1.cumulativeDepositInterest.toString()
		);
		console.log(
			'cumulative borrow interest sol:',
			spotMarket1Before.cumulativeBorrowInterest.toString(),
			'->',
			spotMarket1.cumulativeBorrowInterest.toString()
		);

		// no usd balance or interest changes
		assert(
			spotMarketBefore.cumulativeBorrowInterest.eq(
				spotMarket0.cumulativeBorrowInterest
			)
		);
		assert(
			spotMarketBefore.cumulativeDepositInterest.eq(
				spotMarket0.cumulativeDepositInterest
			)
		);
		assert(netBalance0Before.eq(netBalance0After));

		// sol deposit interest goes down changes (due to social loss)
		assert(
			spotMarket1Before.cumulativeBorrowInterest.eq(
				spotMarket1.cumulativeBorrowInterest
			)
		);
		assert(
			spotMarket1Before.cumulativeDepositInterest.gt(
				spotMarket1.cumulativeDepositInterest
			)
		);

		// sol net balances goes up by socialized (borrow has been forgiven)
		assert(netBalanceBefore.lt(netBalanceAfter));
	});
});
