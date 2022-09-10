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
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
	printTxLogs,
} from './testHelpers';
import { isVariant } from '../sdk';

describe('liquidate perp pnl for deposit', () => {
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
			perpMarketIndexes: [new BN(0)],
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
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(10).mul(BASE_PRECISION),
			new BN(0),
			new BN(0)
		);

		await setFeedPrice(anchor.workspace.Pyth, 0.1, solOracle);
		await clearingHouse.moveAmmToPrice(
			new BN(0),
			new BN(1).mul(MARK_PRICE_PRECISION).div(new BN(10))
		);

		const txSig = await clearingHouse.closePosition(new BN(0));
		printTxLogs(connection, txSig);

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

		const spotMarketIndex = new BN(1);
		await liquidatorClearingHouse.deposit(
			solAmount,
			spotMarketIndex,
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
		await setFeedPrice(anchor.workspace.Pyth, 50, solOracle);

		const txSig = await liquidatorClearingHouse.liquidatePerpPnlForDeposit(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0),
			new BN(0),
			usdcAmount.mul(new BN(100))
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

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(liquidationRecord.liquidationId === 1);
		assert(
			isVariant(liquidationRecord.liquidationType, 'liquidatePerpPnlForDeposit')
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.marketOraclePrice.eq(
				new BN(50).mul(MARK_PRICE_PRECISION)
			)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.perpMarketIndex.eq(ZERO)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.pnlTransfer.eq(
				new BN(9011207)
			)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetPrice.eq(
				MARK_PRICE_PRECISION
			)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetMarketIndex.eq(
				new BN(0)
			)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetTransfer.eq(
				new BN(10000000)
			)
		);
	});
});
