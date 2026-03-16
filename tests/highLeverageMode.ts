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
	setFeedPriceNoProgram,
} from './testHelpers';
import {
	getMarketOrderParams,
	MARGIN_PRECISION,
	MAX_LEVERAGE_ORDER_SIZE,
	OrderParamsBitFlag,
	PERCENTAGE_PRECISION,
	BASE_PRECISION,
} from '../sdk';
import { Transaction } from '@solana/web3.js';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

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

		await driftClient.initializeHighLeverageModeConfig(1);

		await driftClient.updatePerpMarketHighLeverageMarginRatio(
			0,
			MARGIN_PRECISION.divn(100).toNumber(),
			MARGIN_PRECISION.divn(150).toNumber()
		);

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
				bitFlags: OrderParamsBitFlag.UpdateHighLeverageMode,
			})
		);

		let leverage = driftClient.getUser().getLeverage().toNumber() / 10000;
		console.log('leverage', leverage);
		assert(leverage === 99.9);

		await driftClient.cancelOrderByUserId(1);

		// test placing order with short direction
		await driftClient.placePerpOrder(
			getMarketOrderParams({
				direction: PositionDirection.SHORT,
				marketIndex: 0,
				baseAssetAmount: MAX_LEVERAGE_ORDER_SIZE,
				userOrderId: 1,
				bitFlags: OrderParamsBitFlag.UpdateHighLeverageMode,
			})
		);

		leverage = driftClient.getUser().getLeverage().toNumber() / 10000;
		console.log('leverage', leverage);
		assert(leverage === 99.9);

		await driftClient.cancelOrderByUserId(1);
	});

	it('enable user high leverage mode fails when user does not meet maintenance margin requirement', async () => {
		// Open a long position so user has perp exposure
		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(13).mul(BASE_PRECISION),
			0,
			new BN(0)
		);

		await driftClient.disableUserHighLeverageMode(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount()
		);

		// Crash oracle price so the long position has large unrealized loss and user no longer meets maintenance
		await setFeedPriceNoProgram(bankrunContextWrapper, 0.2, solOracle);

		await driftClient.fetchAccounts();

		// Attempt to enable high leverage via instruction; should fail with InsufficientCollateral (0x1773)
		const enableIx = await driftClient.getEnableHighLeverageModeIx(0);
		const tx = new Transaction().add(enableIx);

		let failed = false;
		try {
			await driftClient.sendTransaction(tx);
		} catch (e) {
			const err = e as Error;
			if (err.message.includes('0x1773')) {
				failed = true;
			}
		} finally {
			await setFeedPriceNoProgram(bankrunContextWrapper, 1, solOracle);
			await driftClient.closePosition(0);
		}
		assert(
			failed,
			'enableUserHighLeverageMode should fail with InsufficientCollateral when user does not meet maintenance'
		);
	});
});
