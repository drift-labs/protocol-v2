import * as anchor from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	OracleSource,
	TestClient,
	EventSubscriber,
	PRICE_PRECISION,
	PositionDirection,
} from '../sdk/src';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { OrderType, TWO } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('modify orders', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
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

		velocityClient = new TestClient({
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

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await velocityClient.initializePerpMarket(
			0,
			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('modify order by order id', async () => {
		await velocityClient.placePerpOrder({
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			direction: PositionDirection.LONG,
			orderType: OrderType.LIMIT,
			price: PRICE_PRECISION,
		});

		await velocityClient.modifyOrder({
			orderId: 1,
			newBaseAmount: BASE_PRECISION.mul(TWO),
		});

		assert(
			velocityClient
				.getUser()
				.getUserAccount()
				.orders[0].baseAssetAmount.eq(BASE_PRECISION.mul(TWO))
		);
	});

	it('modify order by user order id', async () => {
		await velocityClient.placePerpOrder({
			userOrderId: 1,
			marketIndex: 0,
			baseAssetAmount: BASE_PRECISION,
			direction: PositionDirection.LONG,
			orderType: OrderType.LIMIT,
			price: PRICE_PRECISION,
		});

		await velocityClient.modifyOrderByUserOrderId({
			userOrderId: 1,
			newBaseAmount: BASE_PRECISION.mul(TWO),
		});

		assert(
			velocityClient
				.getUser()
				.getUserAccount()
				.orders[1].baseAssetAmount.eq(BASE_PRECISION.mul(TWO))
		);
	});
});
