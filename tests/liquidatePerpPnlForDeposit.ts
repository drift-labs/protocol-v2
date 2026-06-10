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
	LIQUIDATION_PCT_PRECISION,
	convertToNumber,
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
import {
	isVariant,
	PERCENTAGE_PRECISION,
	QUOTE_PRECISION,
	UserStatus,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('liquidate perp pnl for deposit', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorVelocityClient: TestClient;
	let liquidatorVelocityClientWSOLAccount: PublicKey;

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

	let _throwaway: PublicKey;

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

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
			new BN(5 * 10 ** 9)
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

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
			activeSubAccountId: 0,
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

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await velocityClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await velocityClient.initializeUserAccountAndDepositCollateral(
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

		await velocityClient.updateOracleGuardRails(oracleGuardRails);

		await velocityClient.openPosition(
			PositionDirection.SHORT,
			new BN(10).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		const solAmount = new BN(10 * 10 ** 9);
		[
			liquidatorVelocityClient,
			liquidatorVelocityClientWSOLAccount,
			_throwaway,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			solAmount.mul(new BN(2000)),
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
			solAmount.mul(new BN(1000)),
			spotMarketIndex,
			liquidatorVelocityClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await velocityClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await liquidatorVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPriceNoProgram(bankrunContextWrapper, 50, solOracle, 10000);
		await velocityClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);
		await velocityClient.updateLiquidationDuration(1);

		const txSig0 = await liquidatorVelocityClient.liquidatePerp(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		bankrunContextWrapper.connection.printTxLogs(txSig0);

		try {
			await liquidatorVelocityClient.liquidatePerpPnlForDeposit(
				await velocityClient.getUserAccountPublicKey(),
				velocityClient.getUserAccount(),
				0,
				0,
				usdcAmount.mul(new BN(100))
			);
		} catch (e) {
			console.log('FAILED to perp pnl settle before paying off borrow');
			// console.error(e);
		}

		// pay off borrow first (and withdraw all excess in attempt to full pay)
		await velocityClient.deposit(new BN(5.02 * 10 ** 8), 1, userWSOLAccount);
		// await velocityClient.withdraw(new BN(1 * 10 ** 8), 1, userWSOLAccount, true);
		await velocityClient.fetchAccounts();

		// const u = velocityClient.getUserAccount();
		// console.log(u.spotPositions[0]);
		// console.log(u.spotPositions[1]);
		// console.log(u.perpPositions[0]);

		const txSig = await liquidatorVelocityClient.liquidatePerpPnlForDeposit(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0,
			0,
			usdcAmount.mul(new BN(600))
		);

		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		console.log('user status:', velocityClient.getUserAccount().status);
		console.log(
			'user collateral:',
			convertToNumber(
				velocityClient.getUser().getTotalCollateral(),
				QUOTE_PRECISION
			)
		);

		assert(
			velocityClient.getUserAccount().status === UserStatus.BEING_LIQUIDATED
		);

		assert(velocityClient.getUserAccount().nextLiquidationId === 2);
		assert(
			velocityClient.getUserAccount().spotPositions[0].scaledBalance.eq(ZERO)
		);
		assert(
			velocityClient.getUserAccount().spotPositions[1].scaledBalance.gt(ZERO)
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
