import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	OracleSource,
	TestClient,
	EventSubscriber,
	PRICE_PRECISION,
	PositionDirection,
	Wallet,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	printTxLogs,
} from './testHelpers';
import {
	BulkAccountLoader,
	findComputeUnitConsumption,
	getOrderParams,
	MarketType,
	OrderParams,
	OrderType,
	PostOnlyParams,
} from '../sdk';

describe('switchboard place orders cus', () => {
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
	const nLpShares = new BN(10000000);

	let oracle: PublicKey;
	const numMkts = 8;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		oracle = await mockOracle(1);

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

			await driftClient.addPerpLpShares(nLpShares.divn(numMkts * 4), i);
		}

		provider.connection.requestAirdrop(traderKeyPair.publicKey, 10 ** 9);
		traderUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			traderKeyPair.publicKey
		);
		traderDriftClient = new TestClient({
			connection,
			wallet: new Wallet(traderKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0, 1, 2, 3, 4, 5, 6, 7],
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

		await printTxLogs(connection, txSig);

		const cus = (
			await findComputeUnitConsumption(
				driftClient.program.programId,
				driftClient.connection,
				txSig
			)
		)[0];
		console.log(cus);
		assert(cus < 380000);
	});
});
