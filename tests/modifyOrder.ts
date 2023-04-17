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
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';
import { BulkAccountLoader, OrderType, TWO } from '../sdk';

describe('modify orders', () => {
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

		const oracle = await mockOracle(1);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
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
			orderType: OrderType.MARKET,
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
			orderType: OrderType.MARKET,
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
