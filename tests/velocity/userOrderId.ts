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
} from '../../packages/sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { ContractTier, ExchangeStatus } from '../../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';

describe('user order id', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let velocityClient: TestClient;
	let velocityClientUser: User;

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
		btcUsd = await mockOracleNoProgram(bankrunContextWrapper, 60000);

		const marketIndexes = [marketIndex, 1];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH_LAZER },
			{ publicKey: btcUsd, source: OracleSource.PYTH_LAZER },
		];

		velocityClient = new TestClient({
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
		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await velocityClient.updatePerpAuctionDuration(new BN(0));

		await velocityClient.fetchAccounts();
		assert(
			velocityClient.getStateAccount().exchangeStatus === ExchangeStatus.ACTIVE
		);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await velocityClient.initializePerpMarket(
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
		await velocityClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await velocityClient.initializePerpMarket(
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
		await velocityClient.fetchAccounts();
		assert(
			isVariant(velocityClient.getPerpMarketAccount(1).status, 'initialized')
		);

		await velocityClient.updatePerpMarketStatus(1, MarketStatus.ACTIVE);
		await velocityClient.fetchAccounts();
		assert(isVariant(velocityClient.getPerpMarketAccount(1).status, 'active'));

		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		velocityClientUser = new User({
			velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClientUser.subscribe();
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await velocityClientUser.unsubscribe();
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
		await velocityClient.placePerpOrder(orderParams);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getUserAccount().orders[0];

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
			await velocityClient.placePerpOrder(orderParams);
		} catch (_) {
			//
			return;
		}
		assert(false);
	});

	it('cancel ', async () => {
		await velocityClient.cancelOrderByUserId(1);

		await velocityClient.fetchAccounts();
		await velocityClientUser.fetchAccounts();
		const order = velocityClientUser.getUserAccount().orders[0];

		assert(isVariant(order.status, 'canceled'));
	});
});
