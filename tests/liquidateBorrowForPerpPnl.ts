import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
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
import { initialize, isVariant } from '../sdk';

describe('liquidate borrow for perp pnl', () => {
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

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		userWSOLAccount = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			ZERO
		);

		solOracle = await mockOracle(1);

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
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await initializeSolAssetBank(clearingHouse, solOracle);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(0);

		const banks = initialize({ env: 'devnet' }).BANKS;
		const usdcBank = banks[0];

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey,
			usdcBank
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(10).mul(BASE_PRECISION),
			new BN(0),
			new BN(0)
		);

		await clearingHouse.moveAmmToPrice(
			new BN(0),
			new BN(2).mul(MARK_PRICE_PRECISION)
		);

		await clearingHouse.closePosition(new BN(0));

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorClearingHouse, liquidatorClearingHouseWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[new BN(0)],
				[new BN(0), new BN(1)],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = new BN(1);
		const bank = banks.find((bank) => bank.bankIndex.eq(bankIndex));
		await liquidatorClearingHouse.deposit(
			solAmount,
			liquidatorClearingHouseWSOLAccount,
			bank
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await clearingHouse.withdraw(solBorrow, bank, userWSOLAccount);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPrice(anchor.workspace.Pyth, 50, solOracle);

		const txSig = await liquidatorClearingHouse.liquidateBorrowForPerpPnl(
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

		assert(!clearingHouse.getUserAccount().beingLiquidated);
		assert(clearingHouse.getUserAccount().positions[0].unsettledPnl.eq(ZERO));

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(
			isVariant(liquidationRecord.liquidationType, 'liquidateBorrowForPerpPnl')
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.marketOraclePrice.eq(
				new BN(50).mul(MARK_PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateBorrowForPerpPnl.marketIndex.eq(ZERO));
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.pnlTransfer.eq(
				new BN(9969234)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.liabilityPrice.eq(
				new BN(50).mul(MARK_PRICE_PRECISION)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.liabilityBankIndex.eq(
				new BN(1)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.liabilityTransfer.eq(
				new BN(199384680)
			)
		);
	});
});
