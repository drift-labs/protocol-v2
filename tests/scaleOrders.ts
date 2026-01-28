import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	EventSubscriber,
	PostOnlyParams,
	SizeDistribution,
	BASE_PRECISION,
	isVariant,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUserUSDCAccount,
	mockUSDCMint,
	initializeQuoteSpotMarket,
	sleep,
} from './testHelpers';
import { OracleSource, ZERO } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('scale orders', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let driftClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let _userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 11).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 11).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(100000 * 10 ** 6); // $100k

	const marketIndex = 0;

	let solUsd;

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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 100);

		const marketIndexes = [marketIndex];
		const bankIndexes = [0];
		const oracleInfos = [
			{ publicKey: PublicKey.default, source: OracleSource.QUOTE_ASSET },
			{ publicKey: solUsd, source: OracleSource.PYTH },
		];

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		let oraclesLoaded = false;
		while (!oraclesLoaded) {
			await driftClient.accountSubscriber.setSpotOracleMap();
			const found =
				!!driftClient.accountSubscriber.getOraclePriceDataAndSlotForSpotMarket(
					0
				);
			if (found) {
				oraclesLoaded = true;
			}
			await sleep(1000);
		}

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		// Set step size to 0.001 (1e6 in base precision)
		await driftClient.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1000000), // 0.001 in BASE_PRECISION
			new BN(1)
		);

		[, _userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	beforeEach(async () => {
		// Clean up any orders from previous tests
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const userAccount = driftClientUser.getUserAccount();
		const hasOpenOrders = userAccount.orders.some((order) =>
			isVariant(order.status, 'open')
		);
		if (hasOpenOrders) {
			await driftClient.cancelOrders();
			await driftClient.fetchAccounts();
			await driftClientUser.fetchAccounts();
		}
	});

	it('place scale orders - flat distribution', async () => {
		const totalBaseAmount = BASE_PRECISION; // 1 SOL
		const orderCount = 5;

		// Long: start high, end low (DCA down)
		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(100).mul(PRICE_PRECISION), // $100 (start high)
			endPrice: new BN(95).mul(PRICE_PRECISION), // $95 (end low)
			orderCount: orderCount,
			sizeDistribution: SizeDistribution.FLAT,
			reduceOnly: false,
			postOnly: PostOnlyParams.NONE,
			bitFlags: 0,
			maxTs: null,
		});

		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userAccount = driftClientUser.getUserAccount();
		const orders = userAccount.orders.filter((order) =>
			isVariant(order.status, 'open')
		);

		assert.equal(orders.length, orderCount, 'Should have 5 open orders');

		// Check orders are distributed across prices (sorted low to high)
		const prices = orders.map((o) => o.price.toNumber()).sort((a, b) => a - b);
		assert.equal(
			prices[0],
			95 * PRICE_PRECISION.toNumber(),
			'Lowest price should be $95'
		);
		assert.equal(
			prices[4],
			100 * PRICE_PRECISION.toNumber(),
			'Highest price should be $100'
		);

		// Check total base amount sums correctly
		const totalBase = orders.reduce(
			(sum, o) => sum.add(o.baseAssetAmount),
			ZERO
		);
		assert.ok(
			totalBase.eq(totalBaseAmount),
			'Total base amount should equal input'
		);

		// Cancel all orders for next test
		await driftClient.cancelOrders();
	});

	it('place scale orders - ascending distribution (long)', async () => {
		const totalBaseAmount = BASE_PRECISION; // 1 SOL
		const orderCount = 3;

		// Long: start high, end low (DCA down)
		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(100).mul(PRICE_PRECISION), // $100 (start high)
			endPrice: new BN(90).mul(PRICE_PRECISION), // $90 (end low)
			orderCount: orderCount,
			sizeDistribution: SizeDistribution.ASCENDING,
			reduceOnly: false,
			postOnly: PostOnlyParams.NONE,
			bitFlags: 0,
			maxTs: null,
		});

		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userAccount = driftClientUser.getUserAccount();
		const orders = userAccount.orders
			.filter((order) => isVariant(order.status, 'open'))
			.sort((a, b) => a.price.toNumber() - b.price.toNumber());

		assert.equal(orders.length, orderCount, 'Should have 3 open orders');

		// For ascending distribution, sizes increase from first to last order
		// First order (at start price $100) is smallest, last order (at end price $90) is largest
		console.log(
			'Order sizes (ascending):',
			orders.map((o) => ({
				price: o.price.toString(),
				size: o.baseAssetAmount.toString(),
			}))
		);

		// Verify sizes - lowest price should have largest size (ascending from start to end)
		assert.ok(
			orders[0].baseAssetAmount.gt(orders[2].baseAssetAmount),
			'Order at lowest price ($90) should have largest size (ascending distribution ends there)'
		);

		// Check total base amount sums correctly
		const totalBase = orders.reduce(
			(sum, o) => sum.add(o.baseAssetAmount),
			ZERO
		);
		assert.ok(
			totalBase.eq(totalBaseAmount),
			'Total base amount should equal input'
		);

		// Cancel all orders for next test
		await driftClient.cancelOrders();
	});

	it('place scale orders - short direction', async () => {
		const totalBaseAmount = BASE_PRECISION.div(new BN(2)); // 0.5 SOL
		const orderCount = 4;

		// Short: start low, end high (scale out up)
		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.SHORT,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(105).mul(PRICE_PRECISION), // $105 (start low)
			endPrice: new BN(110).mul(PRICE_PRECISION), // $110 (end high)
			orderCount: orderCount,
			sizeDistribution: SizeDistribution.FLAT,
			reduceOnly: false,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			bitFlags: 0,
			maxTs: null,
		});

		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userAccount = driftClientUser.getUserAccount();
		const orders = userAccount.orders.filter((order) =>
			isVariant(order.status, 'open')
		);

		assert.equal(orders.length, orderCount, 'Should have 4 open orders');

		// All orders should be short direction
		for (const order of orders) {
			assert.deepEqual(
				order.direction,
				PositionDirection.SHORT,
				'All orders should be SHORT'
			);
		}

		// Check prices are distributed from 105 to 110
		const prices = orders.map((o) => o.price.toNumber()).sort((a, b) => a - b);
		// Allow small rounding tolerance
		const expectedStartPrice = 105 * PRICE_PRECISION.toNumber();
		assert.ok(
			Math.abs(prices[0] - expectedStartPrice) <= 10,
			`Lowest price should be ~$105 (got ${prices[0]}, expected ${expectedStartPrice})`
		);
		const expectedEndPrice = 110 * PRICE_PRECISION.toNumber();
		assert.ok(
			Math.abs(prices[3] - expectedEndPrice) <= 10,
			`Highest price should be ~$110 (got ${prices[3]}, expected ${expectedEndPrice})`
		);

		// Check total base amount sums correctly
		const totalBase = orders.reduce(
			(sum, o) => sum.add(o.baseAssetAmount),
			ZERO
		);
		assert.ok(
			totalBase.eq(totalBaseAmount),
			'Total base amount should equal input'
		);

		// Cancel all orders for next test
		await driftClient.cancelOrders();
	});

	it('place scale orders - descending distribution', async () => {
		const totalBaseAmount = BASE_PRECISION; // 1 SOL
		const orderCount = 3;

		// Long: start high, end low (DCA down)
		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(100).mul(PRICE_PRECISION), // $100 (start high)
			endPrice: new BN(90).mul(PRICE_PRECISION), // $90 (end low)
			orderCount: orderCount,
			sizeDistribution: SizeDistribution.DESCENDING,
			reduceOnly: false,
			postOnly: PostOnlyParams.NONE,
			bitFlags: 0,
			maxTs: null,
		});

		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userAccount = driftClientUser.getUserAccount();
		const orders = userAccount.orders
			.filter((order) => isVariant(order.status, 'open'))
			.sort((a, b) => a.price.toNumber() - b.price.toNumber());

		assert.equal(orders.length, orderCount, 'Should have 3 open orders');

		// For descending distribution, sizes decrease from first order to last
		// First order (at start price $100) gets largest size
		// Last order (at end price $90) gets smallest size
		console.log(
			'Order sizes (descending):',
			orders.map((o) => ({
				price: o.price.toString(),
				size: o.baseAssetAmount.toString(),
			}))
		);

		// Verify sizes - highest price (start) has largest size, lowest price (end) has smallest
		assert.ok(
			orders[2].baseAssetAmount.gt(orders[0].baseAssetAmount),
			'Order at highest price ($100) should have largest size, lowest price ($90) smallest'
		);

		// Check total base amount sums correctly
		const totalBase = orders.reduce(
			(sum, o) => sum.add(o.baseAssetAmount),
			ZERO
		);
		assert.ok(
			totalBase.eq(totalBaseAmount),
			'Total base amount should equal input'
		);

		// Cancel all orders
		await driftClient.cancelOrders();
	});

	it('place scale orders - with reduce only flag', async () => {
		// Test that reduce-only flag is properly set on scale orders
		// Note: We don't need an actual position to test the flag is set correctly
		const totalBaseAmount = BASE_PRECISION.div(new BN(2)); // 0.5 SOL

		// Long: start high, end low (DCA down)
		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(100).mul(PRICE_PRECISION), // $100 (start high)
			endPrice: new BN(95).mul(PRICE_PRECISION), // $95 (end low)
			orderCount: 2,
			sizeDistribution: SizeDistribution.FLAT,
			reduceOnly: true, // Test reduce only flag
			postOnly: PostOnlyParams.NONE,
			bitFlags: 0,
			maxTs: null,
		});

		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userAccount = driftClientUser.getUserAccount();
		const orders = userAccount.orders.filter((order) =>
			isVariant(order.status, 'open')
		);

		assert.equal(orders.length, 2, 'Should have 2 open orders');

		// All orders should have reduce only flag set
		for (const order of orders) {
			assert.equal(order.reduceOnly, true, 'Order should be reduce only');
		}

		// Cancel all orders
		await driftClient.cancelOrders();
	});

	it('place scale orders - minimum 2 orders', async () => {
		const totalBaseAmount = BASE_PRECISION;
		const orderCount = 2; // Minimum allowed

		// Long: start high, end low (DCA down)
		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(100).mul(PRICE_PRECISION), // $100 (start high)
			endPrice: new BN(95).mul(PRICE_PRECISION), // $95 (end low)
			orderCount: orderCount,
			sizeDistribution: SizeDistribution.FLAT,
			reduceOnly: false,
			postOnly: PostOnlyParams.NONE,
			bitFlags: 0,
			maxTs: null,
		});

		bankrunContextWrapper.printTxLogs(txSig);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const userAccount = driftClientUser.getUserAccount();
		const orders = userAccount.orders.filter((order) =>
			isVariant(order.status, 'open')
		);

		assert.equal(orders.length, 2, 'Should have exactly 2 orders');

		const prices = orders.map((o) => o.price.toNumber()).sort((a, b) => a - b);
		assert.equal(
			prices[0],
			95 * PRICE_PRECISION.toNumber(),
			'Lowest price should be $95'
		);
		assert.equal(
			prices[1],
			100 * PRICE_PRECISION.toNumber(),
			'Highest price should be $100'
		);

		// Cancel all orders
		await driftClient.cancelOrders();
	});
});
