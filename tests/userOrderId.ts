import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	User,
	getLimitOrderParams,
	MarketStatus,
	AMM_RESERVE_PRECISION,
	OracleSource,
	isVariant,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {BulkAccountLoader, ContractTier, ExchangeStatus} from '../sdk';

describe('user order id', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let driftClient: TestClient;
	let driftClientUser: User;

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

	const marketIndex = 0;
	let solUsd;
	let btcUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);

		const marketIndexes = [marketIndex, 1];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
		];

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
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

		await driftClient.fetchAccounts();
		assert(
			driftClient.getStateAccount().exchangeStatus === ExchangeStatus.ACTIVE
		);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await driftClient.initializePerpMarket(
			1,
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000000), // btc-ish price level
			undefined,
			ContractTier.A,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false
		);
		await driftClient.fetchAccounts();
		assert(
			isVariant(driftClient.getPerpMarketAccount(1).status, 'initialized')
		);

		await driftClient.updatePerpMarketStatus(1, MarketStatus.ACTIVE);
		await driftClient.fetchAccounts();
		assert(isVariant(driftClient.getPerpMarketAccount(1).status, 'active'));

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});

	it('place order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = false;
		const userOrderId = 1;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			userOrderId,
		});
		await driftClient.placePerpOrder(orderParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getUserAccount().orders[0];

		assert(order.userOrderId === userOrderId);
	});

	it('fail to place same user id twice', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = false;
		const userOrderId = 1;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			userOrderId,
		});

		try {
			await driftClient.placePerpOrder(orderParams);
		} catch (_) {
			//
			return;
		}
		assert(false);
	});

	it('cancel ', async () => {
		await driftClient.cancelOrderByUserId(1);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		const order = driftClientUser.getUserAccount().orders[0];

		assert(order.userOrderId === 0);
	});
});
