import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	TestClient,
	BN,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	MarketStatus,
	BASE_PRECISION,
	isVariant,
	OracleSource,
	PEG_PRECISION,
	BulkAccountLoader,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { MARGIN_PRECISION, OrderType } from '../sdk';

describe('multiple maker orders', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1000 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(100);

		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new TestClient({
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
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(100 * PEG_PRECISION.toNumber())
		);
		await fillerDriftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerDriftClient.updatePerpMarketBaseSpread(
			0,
			PRICE_PRECISION.toNumber() / 8
		);

		await fillerDriftClient.updatePerpMarketMarginRatio(
			0,
			MARGIN_PRECISION.toNumber() / 2,
			MARGIN_PRECISION.toNumber() / 3
		);

		await fillerDriftClient.updatePerpMarketMaxSpread(
			0,
			PRICE_PRECISION.toNumber() / 5
		);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	beforeEach(async () => {
		await fillerDriftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('long', async () => {
		const [takerDriftClient, takerUSDCAccount] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await takerDriftClient.deposit(usdcAmount, 0, takerUSDCAccount);

		const [makerDriftClient, makerUSDCAccount] =
			await createUserWithUSDCAccount(
				provider,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await makerDriftClient.deposit(usdcAmount, 0, makerUSDCAccount);

		for (let i = 0; i < 6; i++) {
			await makerDriftClient.placePerpOrder({
				marketIndex: 0,
				direction: PositionDirection.SHORT,
				price: new BN(95 + i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		const takerBaseAssetAmount = new BN(6).mul(BASE_PRECISION);
		await takerDriftClient.placePerpOrder({
			marketIndex: 0,
			orderType: OrderType.LIMIT,
			price: new BN(100).mul(PRICE_PRECISION),
			direction: PositionDirection.LONG,
			baseAssetAmount: takerBaseAssetAmount,
		});

		const txSig = await fillerDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(1),
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
				order: makerDriftClient.getOrder(1),
				makerStats: await makerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		await printTxLogs(connection, txSig);

		const orderActionRecords = eventSubscriber
			.getEventsArray('OrderActionRecord')
			.filter((record) => isVariant(record.action, 'fill'));
		assert(orderActionRecords.length === 6);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(takerBaseAssetAmount));
		assert(takerPosition.quoteAssetAmount.eq(new BN(-585585000)));

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(takerBaseAssetAmount.neg()));
		assert(makerPosition.quoteAssetAmount.eq(new BN(585117000)));

		for (let i = 0; i < 3; i++) {
			await makerDriftClient.placePerpOrder({
				marketIndex: 0,
				direction: PositionDirection.LONG,
				price: new BN(101 - i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		await takerDriftClient.placePerpOrder({
			marketIndex: 0,
			orderType: OrderType.LIMIT,
			price: new BN(90).mul(PRICE_PRECISION),
			direction: PositionDirection.SHORT,
			baseAssetAmount: takerBaseAssetAmount,
		});

		const txSig2 = await fillerDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(2),
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
				order: makerDriftClient.getOrder(7),
				makerStats: await makerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		const takerPosition2 = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition2.baseAssetAmount.eq(new BN(0)));

		await printTxLogs(connection, txSig2);

		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
	});
});
