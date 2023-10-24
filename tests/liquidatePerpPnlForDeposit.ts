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
	LIQUIDATION_PCT_PRECISION,
	convertToNumber,
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
import {
	BulkAccountLoader,
	isVariant,
	PERCENTAGE_PRECISION,
	QUOTE_PRECISION,
	UserStatus,
} from '../sdk';

describe('liquidate perp pnl for deposit', () => {
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
			new BN(5 * 10 ** 9)
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

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOraclePercentDivergence: new BN(10).mul(PERCENTAGE_PRECISION),
				oracleTwap5MinPercentDivergence: new BN(100).mul(PERCENTAGE_PRECISION),
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
			PositionDirection.SHORT,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount.mul(new BN(2000)),
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
			solAmount.mul(new BN(1000)),
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
		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);
		await driftClient.updateLiquidationDuration(1);

		const txSig0 = await liquidatorDriftClient.liquidatePerp(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		await printTxLogs(connection, txSig0);

		try {
			await liquidatorDriftClient.liquidatePerpPnlForDeposit(
				await driftClient.getUserAccountPublicKey(),
				driftClient.getUserAccount(),
				0,
				0,
				usdcAmount.mul(new BN(100))
			);
		} catch (e) {
			console.log('FAILED to perp pnl settle before paying off borrow');
			// console.error(e);
		}

		// pay off borrow first (and withdraw all excess in attempt to full pay)
		await driftClient.deposit(new BN(5.02 * 10 ** 8), 1, userWSOLAccount);
		// await driftClient.withdraw(new BN(1 * 10 ** 8), 1, userWSOLAccount, true);
		await driftClient.fetchAccounts();

		// const u = driftClient.getUserAccount();
		// console.log(u.spotPositions[0]);
		// console.log(u.spotPositions[1]);
		// console.log(u.perpPositions[0]);

		const txSig = await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			usdcAmount.mul(new BN(600))
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

		console.log('user status:', driftClient.getUserAccount().status);
		console.log(
			'user collateral:',
			convertToNumber(
				driftClient.getUser().getTotalCollateral(),
				QUOTE_PRECISION
			)
		);

		assert(driftClient.getUserAccount().status === UserStatus.BEING_LIQUIDATED);

		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		assert(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.eq(ZERO)
		);
		assert(
			driftClient.getUserAccount().spotPositions[1].scaledBalance.gt(ZERO)
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
				new BN(10000000)
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
