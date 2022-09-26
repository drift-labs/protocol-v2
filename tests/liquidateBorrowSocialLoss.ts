import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	ClearingHouse,
	findComputeUnitConsumption,
	BN,
	OracleSource,
	ZERO,
	EventSubscriber,
	PRICE_PRECISION,
	getTokenAmount,
	SpotBalanceType,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
} from './testHelpers';
import { isVariant, ONE } from '../sdk';

describe('liquidate borrow w/ social loss', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		userWSOLAccount = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			ZERO
		);

		solOracle = await mockOracle(100);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorClearingHouse, liquidatorClearingHouseWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				[new BN(0), new BN(1)],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);

		const marketIndex = new BN(1);
		await liquidatorClearingHouse.deposit(
			solAmount,
			marketIndex,
			liquidatorClearingHouseWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await clearingHouse.withdraw(solBorrow, new BN(1), userWSOLAccount);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPrice(anchor.workspace.Pyth, 200, solOracle);
		const spotMarketBefore = clearingHouse.getSpotMarketAccount(0);
		const spotMarket1Before = clearingHouse.getSpotMarketAccount(1);

		const txSig = await liquidatorClearingHouse.liquidateBorrow(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0),
			new BN(1),
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

		assert(clearingHouse.getUserAccount().beingLiquidated);
		assert(clearingHouse.getUserAccount().nextLiquidationId === 2);
		assert(clearingHouse.getUserAccount().spotPositions[0].balance.eq(ZERO));
		assert(
			clearingHouse
				.getUserAccount()
				.spotPositions[1].balance.gt(new BN(5001000)) &&
				clearingHouse
					.getUserAccount()
					.spotPositions[1].balance.lt(new BN(5002000))
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateBorrow'));
		assert(liquidationRecord.liquidateBorrow.assetPrice.eq(PRICE_PRECISION));
		assert(liquidationRecord.liquidateBorrow.assetMarketIndex.eq(ZERO));
		assert(
			liquidationRecord.liquidateBorrow.assetTransfer.eq(new BN(100000000))
		);
		assert(
			liquidationRecord.liquidateBorrow.liabilityPrice.eq(
				new BN(200).mul(PRICE_PRECISION)
			)
		);
		assert(
			liquidationRecord.liquidateBorrow.liabilityMarketIndex.eq(new BN(1))
		);
		assert(
			liquidationRecord.liquidateBorrow.liabilityTransfer.eq(new BN(500000000))
		);
		assert(
			liquidationRecord.liquidateBorrow.ifFee.eq(
				liquidationRecord.liquidateBorrow.liabilityTransfer.div(new BN(100))
			)
		);
		await clearingHouse.fetchAccounts();
		const spotMarket = clearingHouse.getSpotMarketAccount(0);
		const spotMarket1 = clearingHouse.getSpotMarketAccount(1);

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
		assert(interestOfUpdate.eq(ONE));
	});

	it('resolve bankruptcy', async () => {
		const spotMarketBefore = clearingHouse.getSpotMarketAccount(0);
		const spotMarket1Before = clearingHouse.getSpotMarketAccount(1);

		const spotMarketCumulativeDepositInterestBefore =
			clearingHouse.getSpotMarketAccount(1).cumulativeDepositInterest;

		await liquidatorClearingHouse.resolveBorrowBankruptcy(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(1)
		);

		await clearingHouse.fetchAccounts();

		assert(!clearingHouse.getUserAccount().beingLiquidated);
		assert(!clearingHouse.getUserAccount().bankrupt);
		assert(clearingHouse.getUserAccount().spotPositions[1].balance.eq(ZERO));

		const bankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(isVariant(bankruptcyRecord.liquidationType, 'borrowBankruptcy'));
		console.log(bankruptcyRecord.borrowBankruptcy);
		assert(bankruptcyRecord.borrowBankruptcy.marketIndex.eq(ONE));
		console.log(bankruptcyRecord.borrowBankruptcy.borrowAmount.toString());
		assert(
			bankruptcyRecord.borrowBankruptcy.borrowAmount.eq(new BN(5001585)) ||
				bankruptcyRecord.borrowBankruptcy.borrowAmount.eq(new BN(5001268))
		);
		const spotMarket = clearingHouse.getSpotMarketAccount(1);
		assert(
			spotMarket.cumulativeDepositInterest.eq(
				spotMarketCumulativeDepositInterestBefore.sub(
					bankruptcyRecord.borrowBankruptcy.cumulativeDepositInterestDelta
				)
			)
		);

		await clearingHouse.fetchAccounts();
		const spotMarket0 = clearingHouse.getSpotMarketAccount(0);
		const spotMarket1 = clearingHouse.getSpotMarketAccount(1);

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
