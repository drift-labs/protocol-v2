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
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
	MarketStatus,
	LIQUIDATION_PCT_PRECISION,
} from '../packages/sdk/src';

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
import { isVariant, UserStatus } from '../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('liquidate borrow for perp pnl', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorVelocityClient: TestClient;
	let liquidatorVelocityClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(500 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(500 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let _throwaway: PublicKey;

	let eventSubscriber: EventSubscriber;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);
		userWSOLAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			ZERO
		);

		solOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			undefined,
			undefined,
			10000
		);

		velocityClient = new TestClient({
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await velocityClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);
		// await velocityClient.updateLiquidationDuration(1);

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(3600);

		await velocityClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await velocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await velocityClient.initializeUserAccountAndDepositCollateral(
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

		await velocityClient.updateOracleGuardRails(oracleGuardRails);

		// await bankrunContextWrapper.fundKeypair(bankrunContextWrapper.provider.wallet, BigInt(101 * LAMPORTS_PER_SOL));

		await velocityClient.openPosition(
			PositionDirection.LONG,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		await velocityClient.moveAmmToPrice(
			0,
			new BN(1).mul(PRICE_PRECISION).muln(101).divn(100)
		);

		await velocityClient.closePosition(0);

		const solAmount = new BN(10 * 10 ** 9);
		[
			liquidatorVelocityClient,
			liquidatorVelocityClientWSOLAccount,
			_throwaway,
		] = await createUserWithUSDCAndWSOLAccount(
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);
		await liquidatorVelocityClient.subscribe();

		const spotMarketIndex = 1;

		await liquidatorVelocityClient.deposit(
			solAmount,
			spotMarketIndex,
			liquidatorVelocityClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);

		const account =
			await bankrunContextWrapper.connection.getAccountInfoAndContext(
				userWSOLAccount
			);

		console.log(account);

		await velocityClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await liquidatorVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPriceNoProgram(bankrunContextWrapper, 50, solOracle, 10000);

		const txSig = await liquidatorVelocityClient.liquidateBorrowForPerpPnl(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0,
			1,
			new BN(6 * 10 ** 8)
		);

		console.log(txSig);

		const userAccount = velocityClient.getUserAccount();
		assert(userAccount.status === UserStatus.BEING_LIQUIDATED);
		assert(userAccount.nextLiquidationId === 2);
		assert(
			velocityClient.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
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
				new BN(79897 - 10)
			)
		);
		assert(
			liquidationRecord.liquidateBorrowForPerpPnl.pnlTransfer.lt(
				new BN(79897 + 10)
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
				new BN(1597940)
			)
		);
	});
});
