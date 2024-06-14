import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	BN,
	OracleSource,
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
	MarketStatus,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
} from './testHelpers';
import {
	getMarketOrderParams,
	MAX_LEVERAGE_ORDER_SIZE,
	PERCENTAGE_PRECISION,
} from '../sdk';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';


describe('max leverage order params', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let usdcMint;
	let userUSDCAccount;

	let lendorDriftClient: TestClient;
	let lendorDriftClientWSOLAccount: PublicKey;
	let lendorDriftClientUSDCAccount: PublicKey;

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
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);


		eventSubscriber = new EventSubscriber(bankrunContextWrapper.connection.toConnection(), chProgram);
		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
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
				markOraclePercentDivergence: PERCENTAGE_PRECISION.div(new BN(10)),
				oracleTwap5MinPercentDivergence: PERCENTAGE_PRECISION,
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(55), // allow 55x change
			},
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		const lenderSolAmount = new BN(100 * 10 ** 9);
		const lenderUSDCAmount = usdcAmount.mul(new BN(100));
		[
			lendorDriftClient,
			lendorDriftClientWSOLAccount,
			lendorDriftClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			lenderSolAmount,
			lenderUSDCAmount,
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
		await lendorDriftClient.subscribe();

		const spotMarketIndex = 1;
		await lendorDriftClient.deposit(
			lenderSolAmount,
			spotMarketIndex,
			lendorDriftClientWSOLAccount
		);

		await lendorDriftClient.deposit(
			lenderUSDCAmount,
			0,
			lendorDriftClientUSDCAccount
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await lendorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('max perp leverage', async () => {
		await driftClient.placePerpOrder(
			getMarketOrderParams({
				direction: PositionDirection.LONG,
				marketIndex: 0,
				baseAssetAmount: MAX_LEVERAGE_ORDER_SIZE,
				userOrderId: 1,
			})
		);

		let leverage = driftClient.getUser().getLeverage().toNumber() / 10000;
		assert(leverage === 4.9949);

		await driftClient.cancelOrderByUserId(1);

		// test placing order with short direction
		await driftClient.placePerpOrder(
			getMarketOrderParams({
				direction: PositionDirection.SHORT,
				marketIndex: 0,
				baseAssetAmount: MAX_LEVERAGE_ORDER_SIZE,
				userOrderId: 1,
			})
		);

		leverage = driftClient.getUser().getLeverage().toNumber() / 10000;
		assert(leverage === 4.9949);

		await driftClient.cancelOrderByUserId(1);
	});
});
