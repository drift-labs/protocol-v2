import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	AdminClient,
	DriftClient,
	findComputeUnitConsumption,
	BN,
	OracleSource,
	ZERO,
	EventSubscriber,
	PRICE_PRECISION,
	getTokenAmount,
	SpotBalanceType,
	isVariant,
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

describe('liquidate spot', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorDriftClient: DriftClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;

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

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
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
				]
			);

		const marketIndex = 1;
		await liquidatorDriftClient.deposit(
			solAmount,
			marketIndex,
			liquidatorDriftClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await driftClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPrice(anchor.workspace.Pyth, 190, solOracle);
		const spotMarketBefore = driftClient.getSpotMarketAccount(0);
		const spotMarket1Before = driftClient.getSpotMarketAccount(1);

		const txSig = await liquidatorDriftClient.liquidateSpot(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			1,
			new BN(6 * 10 ** 8)
		);

		const computeUnits = await findComputeUnitConsumption(
			driftClient.program.programId,
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

		assert(!driftClient.getUserAccount().isBeingLiquidated); // out of liq territory
		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		assert(
			isVariant(
				driftClient.getUserAccount().spotPositions[0].balanceType,
				'deposit'
			)
		);
		assert(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.gt(ZERO)
		);
		// assert(
		// 	driftClient.getUserAccount().spotPositions[1].scaledBalance.gt(new BN(2))
		// );
		// assert(
		// 	isVariant(
		// 		driftClient.getUserAccount().spotPositions[0].balanceType,
		// 		'borrow'
		// 	)
		// );
		console.log(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.toString()
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateSpot'));
		assert(liquidationRecord.liquidateSpot.assetPrice.eq(PRICE_PRECISION));
		assert(liquidationRecord.liquidateSpot.assetMarketIndex === 0);
		console.log(
			'asset transfer',
			liquidationRecord.liquidateSpot.assetTransfer.toString()
		);

		// todo, why?
		console.log(liquidationRecord.liquidateSpot.assetTransfer.toString());
		assert(
			liquidationRecord.liquidateSpot.assetTransfer.eq(new BN(58826626)) ||
				liquidationRecord.liquidateSpot.assetTransfer.eq(new BN(58826001))
		);
		assert(
			liquidationRecord.liquidateSpot.liabilityPrice.eq(
				new BN(190).mul(PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateSpot.liabilityMarketIndex === 1);
		console.log(
			'liability transfer',
			liquidationRecord.liquidateSpot.liabilityTransfer.toString()
		);
		assert(
			liquidationRecord.liquidateSpot.liabilityTransfer.eq(new BN(309613825)) ||
				liquidationRecord.liquidateSpot.liabilityTransfer.eq(new BN(309610535))
		);

		// if fee costs 1/100th of liability transfer
		assert(
			liquidationRecord.liquidateSpot.ifFee.eq(
				liquidationRecord.liquidateSpot.liabilityTransfer.div(new BN(100))
			)
		);

		// when user has debt paid off
		const userDepositRecord =
			eventSubscriber.getEventsArray('DepositRecord')[3];
		assert(userDepositRecord.userAuthority.equals(driftClient.authority));
		assert(
			userDepositRecord.user.equals(await driftClient.getUserAccountPublicKey())
		);
		assert(isVariant(userDepositRecord.direction, 'deposit'));
		assert(userDepositRecord.depositRecordId.eq(new BN(3)));
		assert(
			userDepositRecord.amount.eq(
				liquidationRecord.liquidateSpot.liabilityTransfer.sub(
					liquidationRecord.liquidateSpot.ifFee
				)
			)
		);
		assert(userDepositRecord.marketIndex === 1);
		assert(isVariant(userDepositRecord.explanation, 'liquidatee'));

		// when liquidator takes on borrow
		const liquidatorWithdrawRecord =
			eventSubscriber.getEventsArray('DepositRecord')[2];
		assert(
			liquidatorWithdrawRecord.userAuthority.equals(
				liquidatorDriftClient.authority
			)
		);
		assert(
			liquidatorWithdrawRecord.user.equals(
				await liquidatorDriftClient.getUserAccountPublicKey()
			)
		);
		assert(isVariant(liquidatorWithdrawRecord.direction, 'withdraw'));
		assert(liquidatorWithdrawRecord.depositRecordId.eq(new BN(4)));
		assert(
			liquidatorWithdrawRecord.amount.eq(
				liquidationRecord.liquidateSpot.liabilityTransfer
			)
		);
		assert(liquidatorWithdrawRecord.marketIndex === 1);
		assert(isVariant(liquidatorWithdrawRecord.explanation, 'liquidator'));

		// when the user has their asset withdrawn
		const userWithdrawRecord =
			eventSubscriber.getEventsArray('DepositRecord')[1];
		assert(userWithdrawRecord.userAuthority.equals(driftClient.authority));
		assert(
			userWithdrawRecord.user.equals(
				await driftClient.getUserAccountPublicKey()
			)
		);
		assert(isVariant(userWithdrawRecord.direction, 'withdraw'));
		assert(userWithdrawRecord.depositRecordId.eq(new BN(2)));
		assert(
			userWithdrawRecord.amount.eq(
				liquidationRecord.liquidateSpot.assetTransfer
			)
		);
		assert(userWithdrawRecord.marketIndex === 0);
		assert(isVariant(userWithdrawRecord.explanation, 'liquidatee'));

		// when the liquidator receives asset
		const liquidatorDepositRecord =
			eventSubscriber.getEventsArray('DepositRecord')[0];
		assert(
			liquidatorDepositRecord.userAuthority.equals(
				liquidatorDriftClient.authority
			)
		);
		assert(
			liquidatorDepositRecord.user.equals(
				await liquidatorDriftClient.getUserAccountPublicKey()
			)
		);
		assert(isVariant(liquidatorDepositRecord.direction, 'deposit'));
		assert(liquidatorDepositRecord.depositRecordId.eq(new BN(3)));
		assert(
			liquidatorDepositRecord.amount.eq(
				liquidationRecord.liquidateSpot.assetTransfer
			)
		);
		assert(liquidatorDepositRecord.marketIndex === 0);
		assert(isVariant(liquidatorDepositRecord.explanation, 'liquidator'));

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

		const netBalanceBefore = spotMarket1Before.depositBalance.sub(
			spotMarket1Before.borrowBalance
		);
		const netBalanceAfter = spotMarket1.depositBalance.sub(
			spotMarket1.borrowBalance
		);

		console.log(
			'netBalance:',
			netBalanceBefore.toString(),
			'->',
			netBalanceAfter.toString()
		);
		assert(netBalanceBefore.sub(netBalanceAfter).lte(new BN(1000)));
	});
});
