import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	EventSubscriber,
	OracleSource,
	PRICE_PRECISION,
	PositionDirection,
	TestClient,
} from '../sdk/src';

import { startAnchor } from 'solana-bankrun';
import { OrderType, TWO } from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { DriftProgram } from '../sdk/src/config';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('modify orders', () => {
	const chProgram = anchor.workspace.Drift as DriftProgram;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

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

		const oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
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
		await eventSubscriber.unsubscribe();
	});

	it('modify order by order id', async () => {
		await driftClient.placePerpOrder({
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			direction: PositionDirection.LONG,
			orderType: OrderType.LIMIT,
			price: PRICE_PRECISION,
		});

		await driftClient.modifyOrder({
			orderId: 1,
			newBaseAmount: BASE_PRECISION.mul(TWO),
		});

		assert(
			driftClient
				.getUser()
				.getUserAccount()
				.orders[0].baseAssetAmount.eq(BASE_PRECISION.mul(TWO))
		);
	});

	it('modify order by user order id', async () => {
		await driftClient.placePerpOrder({
			userOrderId: 1,
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			direction: PositionDirection.LONG,
			orderType: OrderType.LIMIT,
			price: PRICE_PRECISION,
		});

		await driftClient.modifyOrderByUserOrderId({
			userOrderId: 1,
			newBaseAmount: BASE_PRECISION.mul(TWO),
		});

		assert(
			driftClient
				.getUser()
				.getUserAccount()
				.orders[1].baseAssetAmount.eq(BASE_PRECISION.mul(TWO))
		);
	});
});
