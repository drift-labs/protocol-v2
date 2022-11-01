import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	AdminClient,
	DriftClient,
	findComputeUnitConsumption,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
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

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
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

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
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
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(10),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(55), // allow 55x change
			},
			useForLiquidations: false,
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		await setFeedPrice(anchor.workspace.Pyth, 0.1, solOracle);
		await driftClient.moveAmmToPrice(
			0,
			new BN(1).mul(PRICE_PRECISION).div(new BN(10))
		);

		const txSig = await driftClient.closePosition(0);
		printTxLogs(connection, txSig);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[0],
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);
		await liquidatorDriftClient.subscribe();

		const spotMarketIndex = 1;
		await liquidatorDriftClient.deposit(
			solAmount,
			spotMarketIndex,
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
		await setFeedPrice(anchor.workspace.Pyth, 50, solOracle);

		const txSig = await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			usdcAmount.mul(new BN(100))
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

		// assert(driftClient.getUserAccount().isBeingLiquidated);
		assert(isVariant(driftClient.getUserAccount().status, 'bankrupt'));

		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		assert(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.eq(ZERO)
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(liquidationRecord.liquidationId === 1);
		assert(
			isVariant(liquidationRecord.liquidationType, 'liquidatePerpPnlForDeposit')
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.marketOraclePrice.eq(
				new BN(50).mul(PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidatePerpPnlForDeposit.perpMarketIndex === 0);
		console.log(liquidationRecord.liquidatePerpPnlForDeposit.pnlTransfer);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.pnlTransfer.eq(
				new BN(9011005)
			)
		);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetPrice.eq(
				PRICE_PRECISION
			)
		);
		assert(liquidationRecord.liquidatePerpPnlForDeposit.assetMarketIndex === 0);
		assert(
			liquidationRecord.liquidatePerpPnlForDeposit.assetTransfer.eq(
				new BN(10000000)
			)
		);
	});
});
