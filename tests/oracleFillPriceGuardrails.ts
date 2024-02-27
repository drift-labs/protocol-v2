import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

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
	setFeedPrice,
} from './testHelpers';
import { MARGIN_PRECISION, OrderType, PostOnlyParams } from '../sdk';

describe('oracle fill guardrails', () => {
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

	const usdcAmount = new BN(100000 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(20);

		marketIndexes = [0, 1];
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
		// dont fill against the vamm
		await fillerDriftClient.updatePerpAuctionDuration(new BN(100));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(20 * PEG_PRECISION.toNumber())
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

	it('taker long solUsd', async () => {
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

		await setFeedPrice(anchor.workspace.Pyth, 14, solUsd);
		await makerDriftClient.placePerpOrder({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			price: new BN(14).mul(PRICE_PRECISION),
			orderType: OrderType.LIMIT,
			baseAssetAmount: BASE_PRECISION,
		});

		await setFeedPrice(anchor.workspace.Pyth, 31, solUsd);

		await takerDriftClient.placePerpOrder({
			marketIndex: 0,
			orderType: OrderType.LIMIT,
			auctionStartPrice: new BN(100).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(100).mul(PRICE_PRECISION),
			auctionDuration: 100,
			price: new BN(100).mul(PRICE_PRECISION),
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION,
		});

		// move price to $30
		await setFeedPrice(anchor.workspace.Pyth, 30, solUsd);

		const makerInfo = [
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
				makerStats: await makerDriftClient.getUserStatsAccountPublicKey(),
			},
		];
		const firstFillTxSig = await fillerDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(1),
			makerInfo
		);
		await printTxLogs(connection, firstFillTxSig);

		// assert that the
		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(orderActionRecord.action, 'cancel'));

		await makerDriftClient.placePerpOrder({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			price: new BN(31).mul(PRICE_PRECISION),
			orderType: OrderType.LIMIT,
			baseAssetAmount: BASE_PRECISION,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
		});

		let error = false;
		try {
			const txSig = await fillerDriftClient.fillPerpOrder(
				await takerDriftClient.getUserAccountPublicKey(),
				takerDriftClient.getUserAccount(),
				takerDriftClient.getOrder(1),
				makerInfo
			);

			await printTxLogs(connection, txSig);
		} catch (e) {
			error = true;
			assert(e.message.includes('0x1787'));
		}

		assert(error);

		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
	});
});
