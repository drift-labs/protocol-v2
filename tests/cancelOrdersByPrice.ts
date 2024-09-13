import * as anchor from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	getLimitOrderParams,
	OracleSource,
	TestClient,
	PRICE_PRECISION,
	PositionDirection,
} from '../sdk/src';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { isVariant } from '../sdk';

describe('cancel orders by price', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

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

		const oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: oracle,
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

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			0,
			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('should cancel orders above the specified max price', async () => {
		// Place 4 long orders at different prices
		const prices = [9, 10, 11, 12];
		for (const price of prices) {
			console.log(
				`Placing order at price ${price}`,
				new BN(price * PRICE_PRECISION.toNumber())
			);
			await driftClient.placePerpOrder(
				getLimitOrderParams({
					baseAssetAmount: BASE_PRECISION,
					marketIndex: 0,
					direction: PositionDirection.LONG,
					price: new BN(price * PRICE_PRECISION.toNumber()),
				})
			);
		}

		// Cancel orders with max price of $10
		await driftClient.cancelOrdersByPrice(
			PositionDirection.LONG,
			new BN(10 * PRICE_PRECISION.toNumber())
		);

		// Fetch user orders
		const orders = driftClient.getUserAccount().orders;

		// Check that orders with prices $11 and $12 are canceled
		for (const order of orders) {
			console.log('max price test');
			console.log(`Order price: ${order.price.toString()}`);

			if (order.price.eq(new BN(0))) {
				continue;
			}

			if (order.price.gt(new BN(10 * PRICE_PRECISION.toNumber()))) {
				assert.isTrue(
					isVariant(order.status, 'init'),
					`Order with price ${order.price.toString()} should be canceled`
				);
			} else {
				assert.isFalse(
					isVariant(order.status, 'init'),
					`Order with price ${order.price.toString()} should not be canceled`
				);
			}
		}
	});

	it('should cancel orders below the specified min price', async () => {
		// Place 4 long orders at different prices
		const prices = [9, 10, 11, 12];
		for (const price of prices) {
			await driftClient.placePerpOrder(
				getLimitOrderParams({
					baseAssetAmount: BASE_PRECISION,
					marketIndex: 0,
					direction: PositionDirection.LONG,
					price: new BN(price * PRICE_PRECISION.toNumber()),
				})
			);
		}

		// Cancel orders with min price of $11
		// cancelOrdersByPrice
		await driftClient.cancelOrdersByPrice(
			PositionDirection.LONG,
			undefined,
			new BN(11 * PRICE_PRECISION.toNumber())
		);

		// Fetch user orders
		const orders = driftClient.getUserAccount().orders;

		// Check that orders with prices $9 and $10 are canceled
		for (const order of orders) {
			console.log('min price test');
			console.log(`Order price: ${order.price.toString()}`);

			if (order.price.eq(new BN(0))) {
				continue;
			}

			if (order.price.lt(new BN(11 * PRICE_PRECISION.toNumber()))) {
				assert.isTrue(
					isVariant(order.status, 'init'),
					`Order with price ${order.price.toString()} should be canceled`
				);
			} else {
				assert.isFalse(
					isVariant(order.status, 'init'),
					`Order with price ${order.price.toString()} should not be canceled`
				);
			}
		}
	});

	// Similarly, you can create tests for PositionDirection.SHORT following the same pattern.
});
