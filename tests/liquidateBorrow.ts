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
import { isVariant, ONE } from '../sdk';

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
		await setFeedPrice(anchor.workspace.Pyth, 200, solOracle);

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
		assert(clearingHouse.getUserAccount().bankBalances[0].balance.eq(ZERO));
		assert(
			clearingHouse.getUserAccount().bankBalances[1].balance.eq(new BN(2))
		);

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
		assert(
			liquidationRecord.liquidateBorrow.assetTransfer.eq(new BN(100000000))
		);
		assert(
			liquidationRecord.liquidateBorrow.liabilityPrice.eq(
				new BN(200).mul(MARK_PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateBorrow.liabilityBankIndex.eq(new BN(1)));
		assert(
			liquidationRecord.liquidateBorrow.liabilityTransfer.eq(new BN(500000000))
		);

		const bankCumulativeDepositInterestBefore =
			clearingHouse.getBankAccount(1).cumulativeDepositInterest;

		await liquidatorClearingHouse.resolveBorrowBankruptcy(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(1)
		);

		await clearingHouse.fetchAccounts();

		assert(!clearingHouse.getUserAccount().beingLiquidated);
		assert(!clearingHouse.getUserAccount().bankrupt);
		assert(clearingHouse.getUserAccount().bankBalances[1].balance.eq(ZERO));

		const bankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(isVariant(bankruptcyRecord.liquidationType, 'borrowBankruptcy'));
		console.log(bankruptcyRecord.borrowBankruptcy);
		assert(bankruptcyRecord.borrowBankruptcy.bankIndex.eq(ONE));
		assert(bankruptcyRecord.borrowBankruptcy.borrowAmount.eq(new BN(2000)));
		const bank = clearingHouse.getBankAccount(1);
		assert(
			bank.cumulativeDepositInterest.eq(
				bankCumulativeDepositInterestBefore.sub(
					bankruptcyRecord.borrowBankruptcy.cumulativeDepositInterestDelta
				)
			)
		);
	});
});
