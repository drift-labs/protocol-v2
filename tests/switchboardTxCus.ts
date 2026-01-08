import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	EventSubscriber,
	getOrderParams,
	LIQUIDATION_PCT_PRECISION,
	MarketType,
	OracleSource,
	OrderParams,
	OrderType,
	PositionDirection,
	PostOnlyParams,
	PRICE_PRECISION,
	TestClient,
	Wallet,
} from '../sdk/src';

import { Keypair, PublicKey } from '@solana/web3.js';

import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { DriftProgram } from '../sdk/src/config';
import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('switchboard place orders cus', () => {
	const chProgram = anchor.workspace.Drift as DriftProgram;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;
	let userUSDCAccount;

	const traderKeyPair = new Keypair();
	let traderUSDCAccount: Keypair;
	let traderDriftClient: TestClient;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let oracle: PublicKey;
	const numMkts = 8;

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

		oracle = await mockOracleNoProgram(bankrunContextWrapper, 1);

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

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		for (let i = 0; i < numMkts; i++) {
			await driftClient.initializePerpMarket(
				i,
				oracle,
				ammInitialBaseAssetReserve,
				ammInitialQuoteAssetReserve,
				periodicity
			);
		}

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		for (let i = 0; i < numMkts; i++) {
			await driftClient.openPosition(
				PositionDirection.LONG,
				new BN(175)
					.mul(BASE_PRECISION)
					.div(new BN(10))
					.divn(numMkts * 4),
				i,
				new BN(0)
			);
		}

		await bankrunContextWrapper.fundKeypair(traderKeyPair, 10 ** 9);
		traderUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			traderKeyPair.publicKey
		);
		traderDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(traderKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1, 2, 3, 4, 5, 6, 7],
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
		await traderDriftClient.subscribe();

		await traderDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			traderUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await traderDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const orderParams: Array<OrderParams> = [];
		for (let i = 0; i < 26; i++) {
			orderParams.push(
				getOrderParams({
					marketType: MarketType.PERP,
					marketIndex: 0,
					orderType: OrderType.LIMIT,
					baseAssetAmount: BASE_PRECISION,
					postOnly: PostOnlyParams.SLIDE,
					direction: PositionDirection.LONG,
					price: PRICE_PRECISION,
				})
			);
		}

		const txSig = await traderDriftClient.placeOrders(orderParams);

		bankrunContextWrapper.printTxLogs(txSig);

		const cus =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log(cus);
		// TODO: switchboard CUS went up after anchor v0.32.1 update
		assert(cus < 599850);
	});
});
