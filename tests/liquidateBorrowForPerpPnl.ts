import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
	MarketStatus,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	setFeedPriceNoProgram,
} from './testHelpers';
import { isVariant, UserStatus } from '../sdk';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('liquidate borrow for perp pnl', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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

	let liquidatorKeypair: Keypair;

	let _throwaway: PublicKey;

	before(async () => {
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);
		userWSOLAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			ZERO
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
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
		// await driftClient.updateLiquidationDuration(1);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(3600);

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

		// await bankrunContextWrapper.fundKeypair(bankrunContextWrapper.provider.wallet, BigInt(101 * LAMPORTS_PER_SOL));

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		await driftClient.moveAmmToPrice(0, new BN(2).mul(PRICE_PRECISION));

		await driftClient.closePosition(0);

		const solAmount = new BN(10 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount, _throwaway, liquidatorKeypair] =
			await createUserWithUSDCAndWSOLAccount(
				bankrunContextWrapper,
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

		const account = await bankrunContextWrapper.connection.getAccountInfoAndContext(userWSOLAccount);

		console.log(account);

		await driftClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	it('liquidate', async () => {
		await setFeedPriceNoProgram(bankrunContextWrapper, 50, solOracle);

		const txSig = await liquidatorDriftClient.liquidateBorrowForPerpPnl(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			1,
			new BN(6 * 10 ** 8)
		);

		console.log(txSig);

		const userAccount = driftClient.getUserAccount();
		assert(userAccount.status === UserStatus.BEING_LIQUIDATED);
		assert(userAccount.nextLiquidationId === 2);
		assert(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
		);

		const eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram,
		);

		eventSubscriber.initializeForTests();
		
		await eventSubscriber.registerSig(txSig);

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
