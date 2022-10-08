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
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);

		const marketIndex = 1;
		await liquidatorClearingHouse.deposit(
			solAmount,
			marketIndex,
			liquidatorClearingHouseWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await clearingHouse.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPrice(anchor.workspace.Pyth, 190, solOracle);
		const spotMarketBefore = clearingHouse.getSpotMarketAccount(0);
		const spotMarket1Before = clearingHouse.getSpotMarketAccount(1);

		const txSig = await liquidatorClearingHouse.liquidateSpot(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			0,
			1,
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

		assert(!clearingHouse.getUserAccount().isBeingLiquidated); // out of liq territory
		assert(clearingHouse.getUserAccount().nextLiquidationId === 2);
		assert(
			isVariant(
				clearingHouse.getUserAccount().spotPositions[0].balanceType,
				'deposit'
			)
		);
		assert(clearingHouse.getUserAccount().spotPositions[0].balance.gt(ZERO));
		// assert(
		// 	clearingHouse.getUserAccount().spotPositions[1].balance.gt(new BN(2))
		// );
		// assert(
		// 	isVariant(
		// 		clearingHouse.getUserAccount().spotPositions[0].balanceType,
		// 		'borrow'
		// 	)
		// );
		console.log(
			clearingHouse.getUserAccount().spotPositions[0].balance.toString()
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
