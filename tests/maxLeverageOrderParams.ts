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
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
} from './testHelpers';
import {
	BulkAccountLoader,
	getMarketOrderParams,
	MAX_LEVERAGE_ORDER_SIZE,
	PERCENTAGE_PRECISION,
} from '../sdk';

describe('max leverage order params', () => {
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
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

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
			provider,
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
