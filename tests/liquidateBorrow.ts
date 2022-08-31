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
	MARK_PRICE_PRECISION,
	getTokenAmount,
	BankBalanceType,
	isVariant,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolAssetBank,
} from './testHelpers';

describe('liquidate borrow', () => {
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
			marketIndexes: [],
			bankIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await initializeSolAssetBank(clearingHouse, solOracle);

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

		const bankIndex = new BN(1);
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
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
		await setFeedPrice(anchor.workspace.Pyth, 190, solOracle);
		const bankBefore = clearingHouse.getBankAccount(0);
		const bank1Before = clearingHouse.getBankAccount(1);

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

		assert(!clearingHouse.getUserAccount().beingLiquidated); // out of liq territory
		assert(clearingHouse.getUserAccount().nextLiquidationId === 2);
		assert(
			isVariant(
				clearingHouse.getUserAccount().bankBalances[0].balanceType,
				'deposit'
			)
		);
		assert(clearingHouse.getUserAccount().bankBalances[0].balance.gt(ZERO));
		// assert(
		// 	clearingHouse.getUserAccount().bankBalances[1].balance.gt(new BN(2))
		// );
		// assert(
		// 	isVariant(
		// 		clearingHouse.getUserAccount().bankBalances[0].balanceType,
		// 		'borrow'
		// 	)
		// );
		console.log(
			clearingHouse.getUserAccount().bankBalances[0].balance.toString()
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateBorrow'));
		assert(
			liquidationRecord.liquidateBorrow.assetPrice.eq(MARK_PRICE_PRECISION)
		);
		assert(liquidationRecord.liquidateBorrow.assetBankIndex.eq(ZERO));
		console.log(liquidationRecord.liquidateBorrow.assetTransfer.toString());

		// todo, why?
		assert(
			liquidationRecord.liquidateBorrow.assetTransfer.lt(new BN(66904819))
		);
		assert(
			liquidationRecord.liquidateBorrow.assetTransfer.gt(new BN(64904819))
		);
		assert(
			liquidationRecord.liquidateBorrow.liabilityPrice.eq(
				new BN(190).mul(MARK_PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateBorrow.liabilityBankIndex.eq(new BN(1)));
		console.log(liquidationRecord.liquidateBorrow.liabilityTransfer.toString());
		assert(
			liquidationRecord.liquidateBorrow.liabilityTransfer.lt(new BN(347871052))
		);
		assert(
			liquidationRecord.liquidateBorrow.liabilityTransfer.gt(new BN(345871052))
		);
		await clearingHouse.fetchAccounts();
		const bank = clearingHouse.getBankAccount(0);
		const bank1 = clearingHouse.getBankAccount(1);

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
			'usdc deposits in bank:',
			getTokenAmount(
				bankBefore.depositBalance,
				bankBefore,
				BankBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				bank.depositBalance,
				bank,
				BankBalanceType.DEPOSIT
			).toString()
		);

		console.log(
			'sol borrows in bank:',
			getTokenAmount(
				bank1Before.borrowBalance,
				bank1Before,
				BankBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				bank1.borrowBalance,
				bank1,
				BankBalanceType.BORROW
			).toString()
		);

		console.log(
			'sol deposits in bank:',
			getTokenAmount(
				bank1Before.depositBalance,
				bank1Before,
				BankBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				bank1.depositBalance,
				bank1,
				BankBalanceType.DEPOSIT
			).toString()
		);

		const netBalanceBefore = bank1Before.depositBalance.sub(
			bank1Before.borrowBalance
		);
		const netBalanceAfter = bank1.depositBalance.sub(bank1.borrowBalance);

		console.log(
			'netBalance:',
			netBalanceBefore.toString(),
			'->',
			netBalanceAfter.toString()
		);
		assert(netBalanceBefore.eq(netBalanceAfter));
	});
});
