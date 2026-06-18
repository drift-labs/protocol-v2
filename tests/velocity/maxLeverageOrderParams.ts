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
} from '../../packages/sdk/src';

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
} from '../../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('max leverage order params', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let usdcMint;
	let userUSDCAccount;

	let lendorVelocityClient: TestClient;
	let lendorVelocityClientWSOLAccount: PublicKey;
	let lendorVelocityClientUSDCAccount: PublicKey;

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
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);
		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			1,
			-7,
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
		await velocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await velocityClient.initializeUserAccountAndDepositCollateral(
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

		await velocityClient.updateOracleGuardRails(oracleGuardRails);

		const lenderSolAmount = new BN(100 * 10 ** 9);
		const lenderUSDCAmount = usdcAmount.mul(new BN(100));
		[
			lendorVelocityClient,
			lendorVelocityClientWSOLAccount,
			lendorVelocityClientUSDCAccount,
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
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);
		await lendorVelocityClient.subscribe();

		const spotMarketIndex = 1;
		await lendorVelocityClient.deposit(
			lenderSolAmount,
			spotMarketIndex,
			lendorVelocityClientWSOLAccount
		);

		await lendorVelocityClient.deposit(
			lenderUSDCAmount,
			0,
			lendorVelocityClientUSDCAccount
		);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await lendorVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('max perp leverage', async () => {
		await velocityClient.placePerpOrder(
			getMarketOrderParams({
				direction: PositionDirection.LONG,
				marketIndex: 0,
				baseAssetAmount: MAX_LEVERAGE_ORDER_SIZE,
				userOrderId: 1,
			})
		);

		let leverage = velocityClient.getUser().getLeverage().toNumber() / 10000;
		assert(leverage === 4.995);

		await velocityClient.cancelOrderByUserId(1);

		// test placing order with short direction
		await velocityClient.placePerpOrder(
			getMarketOrderParams({
				direction: PositionDirection.SHORT,
				marketIndex: 0,
				baseAssetAmount: MAX_LEVERAGE_ORDER_SIZE,
				userOrderId: 1,
			})
		);

		leverage = velocityClient.getUser().getLeverage().toNumber() / 10000;
		assert(leverage === 4.995);

		await velocityClient.cancelOrderByUserId(1);
	});
});
