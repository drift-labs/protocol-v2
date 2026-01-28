import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	Wallet,
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

	let userAccountPublicKey: PublicKey;

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

		[, userAccountPublicKey] =
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

		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(95).mul(PRICE_PRECISION), // $95
			endPrice: new BN(100).mul(PRICE_PRECISION), // $100
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

		// Check orders are distributed across prices
		const prices = orders.map((o) => o.price.toNumber()).sort((a, b) => a - b);
		assert.equal(
			prices[0],
			95 * PRICE_PRECISION.toNumber(),
			'First price should be $95'
		);
		assert.equal(
			prices[4],
			100 * PRICE_PRECISION.toNumber(),
			'Last price should be $100'
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

		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(90).mul(PRICE_PRECISION), // $90
			endPrice: new BN(100).mul(PRICE_PRECISION), // $100
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

		// For ascending, smallest order at lowest price, largest at highest price
		// Since it's ascending and long, orders at lower prices are smaller
		console.log(
			'Order sizes (ascending):',
			orders.map((o) => ({
				price: o.price.toString(),
				size: o.baseAssetAmount.toString(),
			}))
		);

		// Verify sizes are ascending with price
		assert.ok(
			orders[0].baseAssetAmount.lt(orders[2].baseAssetAmount),
			'First order (lowest price) should be smaller than last order (highest price)'
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

		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.SHORT,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(110).mul(PRICE_PRECISION), // $110 (start high for shorts)
			endPrice: new BN(105).mul(PRICE_PRECISION), // $105 (end low)
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

		// Check prices are distributed from 110 to 105
		const prices = orders.map((o) => o.price.toNumber()).sort((a, b) => b - a);
		assert.equal(
			prices[0],
			110 * PRICE_PRECISION.toNumber(),
			'First price should be $110'
		);
		// Allow small rounding tolerance for end price
		const expectedEndPrice = 105 * PRICE_PRECISION.toNumber();
		assert.ok(
			Math.abs(prices[3] - expectedEndPrice) <= 10,
			`Last price should be ~$105 (got ${prices[3]}, expected ${expectedEndPrice})`
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

		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(90).mul(PRICE_PRECISION),
			endPrice: new BN(100).mul(PRICE_PRECISION),
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

		// For descending, largest order at lowest price, smallest at highest price
		console.log(
			'Order sizes (descending):',
			orders.map((o) => ({
				price: o.price.toString(),
				size: o.baseAssetAmount.toString(),
			}))
		);

		// Verify sizes are descending with price
		assert.ok(
			orders[0].baseAssetAmount.gt(orders[2].baseAssetAmount),
			'First order (lowest price) should be larger than last order (highest price)'
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

		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(95).mul(PRICE_PRECISION),
			endPrice: new BN(100).mul(PRICE_PRECISION),
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

		const txSig = await driftClient.placeScalePerpOrders({
			direction: PositionDirection.LONG,
			marketIndex: 0,
			totalBaseAssetAmount: totalBaseAmount,
			startPrice: new BN(95).mul(PRICE_PRECISION),
			endPrice: new BN(100).mul(PRICE_PRECISION),
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
			'First price should be $95'
		);
		assert.equal(
			prices[1],
			100 * PRICE_PRECISION.toNumber(),
			'Second price should be $100'
		);

		// Cancel all orders
		await driftClient.cancelOrders();
	});
});
