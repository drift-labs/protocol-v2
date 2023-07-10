import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	TestClient,
	findComputeUnitConsumption,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
	MarketStatus,
	LIQUIDATION_PCT_PRECISION,
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
import { BulkAccountLoader, isVariant } from '../sdk';

describe('liquidate borrow for perp pnl', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorDriftClient: TestClient;
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

		driftClient = new TestClient({
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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(1000000),
				oracleTwap5MinPercentDivergence: new BN(1000000),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(55), // allow 55x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		await driftClient.moveAmmToPrice(0, new BN(2).mul(PRICE_PRECISION));

		await driftClient.closePosition(0);

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
				],
				bulkAccountLoader
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

		const txSig = await liquidatorDriftClient.liquidateBorrowForPerpPnl(
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

		assert(isVariant(driftClient.getUserAccount().status, 'beingLiquidated'));
		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		assert(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];

		assert(liquidationRecord.liquidationId === 1);
		assert(
			isVariant(liquidationRecord.liquidationType, 'liquidateBorrowForPerpPnl')
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.marketOraclePrice.eq(
				new BN(50).mul(PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateBorrowForPerpPnl.perpMarketIndex === 0);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.pnlTransfer.gt(
				new BN(9969992 - 10)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.pnlTransfer.lt(
				new BN(9969992 + 10)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.liabilityPrice.eq(
				new BN(50).mul(PRICE_PRECISION)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.liabilityMarketIndex === 1
		);

		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.liabilityTransfer.eq(
				new BN(199399800)
			)
		);
	});
});
