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
	getMarketOrderParams,
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
	OrderStatus,
} from '../sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
	initializeQuoteSpotMarket,
} from './testHelpers';
import {
	BASE_PRECISION,
	convertToNumber,
	OracleSource,
	PERCENTAGE_PRECISION,
	QUOTE_PRECISION,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('Cancel trigger orders on position close (Issue #923)', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let bulkAccountLoader: TestBulkAccountLoader;
	let bankrunContextWrapper: BankrunContextWrapper;

	let driftClient: TestClient;
	let driftClientUser: User;

	let fillerDriftClient: TestClient;
	let fillerDriftClientUser: User;

	let usdcMint;
	let userUSDCAccount;

	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [
			{
				publicKey: solUsd,
				source: OracleSource.PYTH,
			},
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
			spotMarketIndexes: spotMarketIndexes,
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

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		driftClientUser = new User({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClientUser.subscribe();

		// Create a filler client (needed to fill orders)
		fillerDriftClient = driftClient;
		fillerDriftClientUser = driftClientUser;
	});

	beforeEach(async () => {
		await driftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('Trigger orders are cancelled when short position is closed', async () => {
		// Set oracle price to $1
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);

		// Step 1: Open a short position
		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
		});
		await driftClient.placePerpOrder(orderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const orderIndex = 0;
		const order = driftClientUser.getUserAccount().orders[orderIndex];
		assert.ok(order.baseAssetAmount.eq(BASE_PRECISION));

		// Fill the short order
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Verify short position is open
		const position = driftClientUser.getUserAccount().perpPositions[0];
		assert.ok(position.baseAssetAmount.lt(new BN(0))); // Negative = short

		// Step 2: Place a stop-loss trigger order (should trigger if price goes above $1.10)
		const triggerOrderParams = getTriggerMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG, // To close the short
			baseAssetAmount: BASE_PRECISION,
			triggerPrice: PRICE_PRECISION.mul(new BN(110)).div(new BN(100)), // $1.10
			triggerCondition: OrderTriggerCondition.ABOVE,
		});
		await driftClient.placePerpOrder(triggerOrderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Verify trigger order exists
		let triggerOrder = driftClientUser.getUserAccount().orders.find(
			(o) => o.status === OrderStatus.OPEN && o.triggerPrice.gt(new BN(0))
		);
		assert.ok(triggerOrder !== undefined, 'Trigger order should exist');
		assert.ok(
			triggerOrder.triggerPrice.eq(
				PRICE_PRECISION.mul(new BN(110)).div(new BN(100))
			),
			'Trigger price should be $1.10'
		);

		// Step 3: Close the short position with a market order
		const closeOrderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG, // Opposite direction to close
			baseAssetAmount: BASE_PRECISION,
		});
		await driftClient.placePerpOrder(closeOrderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const closeOrder =
			driftClientUser.getUserAccount().orders[
				driftClientUser.getUserAccount().orders.findIndex(
					(o) => o.status === OrderStatus.OPEN && o.triggerPrice.eq(new BN(0))
				)
			];

		// Fill the closing order
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			closeOrder
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Verify position is completely closed
		const closedPosition = driftClientUser.getUserAccount().perpPositions[0];
		assert.ok(
			closedPosition.baseAssetAmount.eq(new BN(0)),
			'Position should be completely closed'
		);

		// Step 4: Verify trigger order was automatically cancelled (THE FIX)
		triggerOrder = driftClientUser.getUserAccount().orders.find(
			(o) => o.status === OrderStatus.OPEN && o.triggerPrice.gt(new BN(0))
		);
		assert.ok(
			triggerOrder === undefined,
			'Trigger order should be automatically cancelled when position closes'
		);

		console.log('✅ Test passed: Trigger orders are cancelled on position close');
	});

	it('Trigger orders remain active when position is only partially closed', async () => {
		// Set oracle price to $1
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);

		// Step 1: Open a larger short position (2x BASE_PRECISION)
		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION.mul(new BN(2)),
		});
		await driftClient.placePerpOrder(orderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const order = driftClientUser.getUserAccount().orders[0];

		// Fill the short order
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Step 2: Place a stop-loss trigger order
		const triggerOrderParams = getTriggerMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION.mul(new BN(2)),
			triggerPrice: PRICE_PRECISION.mul(new BN(110)).div(new BN(100)),
			triggerCondition: OrderTriggerCondition.ABOVE,
		});
		await driftClient.placePerpOrder(triggerOrderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Step 3: Partially close the position (only 1x BASE_PRECISION)
		const partialCloseParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION, // Only half
		});
		await driftClient.placePerpOrder(partialCloseParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const partialCloseOrder =
			driftClientUser.getUserAccount().orders[
				driftClientUser.getUserAccount().orders.findIndex(
					(o) => o.status === OrderStatus.OPEN && o.triggerPrice.eq(new BN(0))
				)
			];

		// Fill the partial closing order
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			partialCloseOrder
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Verify position is still open (not completely closed)
		const position = driftClientUser.getUserAccount().perpPositions[0];
		assert.ok(
			!position.baseAssetAmount.eq(new BN(0)),
			'Position should still be open'
		);

		// Verify trigger order is still active (should NOT be cancelled)
		const triggerOrder = driftClientUser.getUserAccount().orders.find(
			(o) => o.status === OrderStatus.OPEN && o.triggerPrice.gt(new BN(0))
		);
		assert.ok(
			triggerOrder !== undefined,
			'Trigger order should remain active when position is only partially closed'
		);

		console.log(
			'✅ Test passed: Trigger orders remain active on partial position close'
		);
	});

	it('Multiple trigger orders are all cancelled when position closes', async () => {
		// Set oracle price to $1
		await setFeedPriceNoProgram(bankrunContextWrapper, 1, solUsd);

		// Step 1: Open a short position
		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			baseAssetAmount: BASE_PRECISION,
		});
		await driftClient.placePerpOrder(orderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const order = driftClientUser.getUserAccount().orders[0];

		// Fill the short order
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			order
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Step 2: Place multiple trigger orders (stop-loss and take-profit)
		const stopLossParams = getTriggerMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			triggerPrice: PRICE_PRECISION.mul(new BN(110)).div(new BN(100)), // $1.10
			triggerCondition: OrderTriggerCondition.ABOVE,
		});
		await driftClient.placePerpOrder(stopLossParams);

		const takeProfitParams = getTriggerMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
			triggerPrice: PRICE_PRECISION.mul(new BN(90)).div(new BN(100)), // $0.90
			triggerCondition: OrderTriggerCondition.BELOW,
		});
		await driftClient.placePerpOrder(takeProfitParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Verify both trigger orders exist
		let triggerOrders = driftClientUser
			.getUserAccount()
			.orders.filter(
				(o) => o.status === OrderStatus.OPEN && o.triggerPrice.gt(new BN(0))
			);
		assert.equal(
			triggerOrders.length,
			2,
			'Should have 2 trigger orders (stop-loss and take-profit)'
		);

		// Step 3: Close the position
		const closeOrderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
		});
		await driftClient.placePerpOrder(closeOrderParams);
		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		const closeOrder =
			driftClientUser.getUserAccount().orders[
				driftClientUser.getUserAccount().orders.findIndex(
					(o) => o.status === OrderStatus.OPEN && o.triggerPrice.eq(new BN(0))
				)
			];

		// Fill the closing order
		await fillerDriftClient.fillPerpOrder(
			await driftClientUser.getUserAccountPublicKey(),
			driftClientUser.getUserAccount(),
			closeOrder
		);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();

		// Verify ALL trigger orders were cancelled
		triggerOrders = driftClientUser
			.getUserAccount()
			.orders.filter(
				(o) => o.status === OrderStatus.OPEN && o.triggerPrice.gt(new BN(0))
			);
		assert.equal(
			triggerOrders.length,
			0,
			'All trigger orders should be cancelled when position closes'
		);

		console.log('✅ Test passed: Multiple trigger orders are all cancelled');
	});
});
