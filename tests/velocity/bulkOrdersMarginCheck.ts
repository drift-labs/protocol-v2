import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	BN,
	OracleSource,
	TestClient,
	PRICE_PRECISION,
	BASE_PRECISION,
	PositionDirection,
	EventSubscriber,
	OracleGuardRails,
	MarketStatus,
	LIQUIDATION_PCT_PRECISION,
	PERCENTAGE_PRECISION,
	getLimitOrderParams,
	PostOnlyParams,
} from '../../packages/sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

// Regression suite for the bulk `place_orders` margin-check bypass.
//
// `place_orders` defers the margin check until after the whole batch is placed.
// The check must (a) use the accumulated risk-increasing flag across every
// order in the batch — not just the last order's — so it runs against initial
// (not maintenance) margin, and (b) run even when the final order is an allowed
// no-op (expired or `TryPostOnly` that couldn't post). Otherwise an early
// risk-increasing order could be admitted under a weaker (or absent) check by
// appending a non-risk-increasing / no-op final order.
describe('bulk place_orders margin check', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let usdcMint;
	let userUSDCAccount;

	let solOracle: PublicKey;

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	// $10 of collateral. With the market's default 20% initial / 5% maintenance
	// ratios and SOL at $1, this supports ~$50 of notional at initial margin and
	// ~$200 at maintenance margin.
	const usdcAmount = new BN(10 * 10 ** 6);

	// 150 SOL ≈ $150 notional: fails initial margin ($30 > $10) but passes
	// maintenance margin ($7.50 < $10). The gap is what the bug exposed — a
	// non-risk-increasing final order downgraded the batch check to maintenance.
	const initialMarginFailingBase = BASE_PRECISION.muln(150);
	// 30 SOL ≈ $30 notional: comfortably within initial margin ($6 < $10).
	const withinInitialMarginBase = BASE_PRECISION.muln(30);

	const pastMaxTs = new BN(1); // unix ts in the past -> order is expired on arrival

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

		await velocityClient.initializePerpMarket(
			0,
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0)
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
				tooVolatileRatio: new BN(55),
			},
		};
		await velocityClient.updateOracleGuardRails(oracleGuardRails);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	// A resting bid below the oracle so the order is risk-increasing but does not
	// cross / fill during placement.
	const restingLongBig = () =>
		getLimitOrderParams({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			baseAssetAmount: initialMarginFailingBase,
			price: PRICE_PRECISION.muln(9).divn(10), // $0.90
		});

	const restingLongSmall = (userOrderId: number) =>
		getLimitOrderParams({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			baseAssetAmount: withinInitialMarginBase,
			price: PRICE_PRECISION.muln(9).divn(10),
			userOrderId,
		});

	// reduce_only -> not risk-increasing (see `is_new_order_risk_increasing`),
	// which is exactly what could downgrade the buggy last-order check to
	// maintenance margin.
	const reduceOnlyFinal = () =>
		getLimitOrderParams({
			direction: PositionDirection.SHORT,
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			price: PRICE_PRECISION.muln(11).divn(10), // $1.10
			reduceOnly: true,
		});

	const expiredFinal = () =>
		getLimitOrderParams({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			price: PRICE_PRECISION.muln(9).divn(10),
			maxTs: pastMaxTs,
		});

	// TryPostOnly priced through the oracle -> cannot post -> placed as a no-op.
	const tryPostOnlyFinal = () =>
		getLimitOrderParams({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			price: PRICE_PRECISION.muln(2), // $2, crosses the $1 oracle
			postOnly: PostOnlyParams.TRY_POST_ONLY,
		});

	const expectInitialMarginFailure = async (params, label: string) => {
		let failed = false;
		try {
			await velocityClient.placeOrders(params);
		} catch (e) {
			failed = true;
			assert(
				e.message.includes('0x1773'),
				`${label}: expected InsufficientCollateral (0x1773), got: ${e.message}`
			);
		}
		assert(
			failed,
			`${label}: batch should have failed the initial margin check`
		);
		// Failed tx must be atomic — no orders should have landed.
		await velocityClient.fetchAccounts();
		assert(
			velocityClient.getUser().getOpenOrders().length === 0,
			`${label}: no orders should rest after a rejected batch`
		);
	};

	it('rejects a risk-increasing order followed by a non-risk-increasing (reduce-only) final order', async () => {
		await expectInitialMarginFailure(
			[restingLongBig(), reduceOnlyFinal()],
			'reduce-only final'
		);
	});

	it('rejects a risk-increasing order followed by an expired final order', async () => {
		await expectInitialMarginFailure(
			[restingLongBig(), expiredFinal()],
			'expired final'
		);
	});

	it('rejects a risk-increasing order followed by a TryPostOnly no-op final order', async () => {
		await expectInitialMarginFailure(
			[restingLongBig(), tryPostOnlyFinal()],
			'try-post-only final'
		);
	});

	it('still admits a batch that meets initial margin with a no-op final order', async () => {
		await velocityClient.placeOrders([restingLongSmall(1), expiredFinal()]);
		await velocityClient.fetchAccounts();
		const openOrders = velocityClient.getUser().getOpenOrders();
		// only the risk-increasing order rests; the expired final order is a no-op
		assert(
			openOrders.length === 1,
			`expected 1 resting order, got ${openOrders.length}`
		);
		await velocityClient.cancelOrders();
	});

	it('still admits a batch of risk-increasing orders within initial margin', async () => {
		await velocityClient.placeOrders([restingLongSmall(1)]);
		await velocityClient.fetchAccounts();
		assert(velocityClient.getUser().getOpenOrders().length === 1);
		await velocityClient.cancelOrders();
	});
});
