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

	const usdcAmount = new BN(100000 * 10 ** 6);

	let solUsd;
	let dogUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(100);
		dogUsd = await mockOracle(0.6899, -4, 0);

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
		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			0,
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

		await fillerDriftClient.initializePerpMarket(
			1,
			dogUsd,
			ammInitialBaseAssetReserve.div(new BN(100000)),
			ammInitialQuoteAssetReserve.div(new BN(100000)),
			periodicity,
			new BN(0.69 * PEG_PRECISION.toNumber()),
			OracleSource.PYTH,
			MARGIN_PRECISION.toNumber() / 4, // 4x
			MARGIN_PRECISION.toNumber() / 5 // 5x
		);
		await fillerDriftClient.updatePerpMarketStatus(1, MarketStatus.ACTIVE);

		await fillerDriftClient.updatePerpMarketBaseSpread(
			1,
			PRICE_PRECISION.toNumber() / 80
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

		for (let i = 0; i < 6; i++) {
			await makerDriftClient.placePerpOrder({
				marketIndex: 0,
				direction: PositionDirection.SHORT,
				price: new BN(95 + i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		const [secondMakerDriftClient, secondMakerUSDCAccount] =
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

		await secondMakerDriftClient.deposit(usdcAmount, 0, secondMakerUSDCAccount);

		for (let i = 0; i < 6; i++) {
			await secondMakerDriftClient.placePerpOrder({
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

		const makerInfo = [
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
				makerStats: await makerDriftClient.getUserStatsAccountPublicKey(),
			},
			{
				maker: await secondMakerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: secondMakerDriftClient.getUserAccount(),
				makerStats: await secondMakerDriftClient.getUserStatsAccountPublicKey(),
			},
		];
		const txSig = await fillerDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(1),
			makerInfo
		);

		await printTxLogs(connection, txSig);

		const orderActionRecords = eventSubscriber
			.getEventsArray('OrderActionRecord')
			.filter((record) => isVariant(record.action, 'fill'));
		assert(orderActionRecords.length === 6);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(takerBaseAssetAmount));
		assert(takerPosition.quoteAssetAmount.eq(new BN(-576576000)));

		const makerPosition = makerDriftClient.getUser().getPerpPosition(0);
		assert(
			makerPosition.baseAssetAmount.eq(
				takerBaseAssetAmount.neg().div(new BN(2))
			)
		);
		assert(makerPosition.quoteAssetAmount.eq(new BN(288057600)));

		const secondMakerPosition = secondMakerDriftClient
			.getUser()
			.getPerpPosition(0);
		assert(
			secondMakerPosition.baseAssetAmount.eq(
				takerBaseAssetAmount.neg().div(new BN(2))
			)
		);
		assert(secondMakerPosition.quoteAssetAmount.eq(new BN(288057600)));

		for (let i = 0; i < 3; i++) {
			await makerDriftClient.placePerpOrder({
				marketIndex: 0,
				direction: PositionDirection.LONG,
				price: new BN(101 - i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		for (let i = 0; i < 3; i++) {
			await secondMakerDriftClient.placePerpOrder({
				marketIndex: 0,
				direction: PositionDirection.LONG,
				price: new BN(101 - i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		await setFeedPrice(anchor.workspace.Pyth, 90, solUsd);
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
			makerInfo
		);

		const takerPosition2 = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition2.baseAssetAmount.eq(new BN(0)));

		await printTxLogs(connection, txSig2);

		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await secondMakerDriftClient.unsubscribe();
	});

	it('taker short dogUsd', async () => {
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

		for (let i = 0; i < 1; i++) {
			await makerDriftClient.placePerpOrder({
				marketIndex: 1,
				direction: PositionDirection.LONG,
				price: new BN((0.69 - i / 100) * PRICE_PRECISION.toNumber()),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		const [secondMakerDriftClient, secondMakerUSDCAccount] =
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

		await secondMakerDriftClient.deposit(usdcAmount, 0, secondMakerUSDCAccount);

		for (let i = 0; i < 16; i++) {
			await secondMakerDriftClient.placePerpOrder({
				marketIndex: 1,
				direction: PositionDirection.LONG,
				price: new BN((0.69 - i / 500) * PRICE_PRECISION.toNumber()),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		const [thirdMakerDriftClient, thirdMakerUSDCAccount] =
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
		await thirdMakerDriftClient.deposit(usdcAmount, 0, thirdMakerUSDCAccount);

		for (let i = 0; i < 32; i++) {
			if (i % 2 == 0) {
				await thirdMakerDriftClient.placePerpOrder({
					marketIndex: 1,
					direction: PositionDirection.LONG,
					price: new BN((0.69 - i / 1000) * PRICE_PRECISION.toNumber()),
					orderType: OrderType.LIMIT,
					baseAssetAmount: BASE_PRECISION,
				});
			} else {
				await thirdMakerDriftClient.placePerpOrder({
					marketIndex: 1,
					direction: PositionDirection.LONG,
					oraclePriceOffset: -(i / 1000) * PRICE_PRECISION.toNumber(),
					orderType: OrderType.LIMIT,
					baseAssetAmount: BASE_PRECISION,
				});
			}
		}

		await setFeedPrice(anchor.workspace.Pyth, 0.675, dogUsd);
		const takerBaseAssetAmount = new BN(600).mul(BASE_PRECISION);
		await takerDriftClient.placePerpOrder({
			marketIndex: 1,
			orderType: OrderType.LIMIT,
			price: new BN(0.675 * PRICE_PRECISION.toNumber()),
			direction: PositionDirection.SHORT,
			baseAssetAmount: takerBaseAssetAmount,
		});

		const makerInfo = [
			{
				maker: await makerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: makerDriftClient.getUserAccount(),
				makerStats: await makerDriftClient.getUserStatsAccountPublicKey(),
			},
			{
				maker: await secondMakerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: secondMakerDriftClient.getUserAccount(),
				makerStats: await secondMakerDriftClient.getUserStatsAccountPublicKey(),
			},
			{
				maker: await thirdMakerDriftClient.getUserAccountPublicKey(),
				makerUserAccount: thirdMakerDriftClient.getUserAccount(),
				makerStats: await thirdMakerDriftClient.getUserStatsAccountPublicKey(),
			},
		];
		const txSig = await fillerDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(1),
			makerInfo
		);

		await printTxLogs(connection, txSig);

		const orderActionRecords = eventSubscriber
			.getEventsArray('OrderActionRecord')
			.filter((record) => isVariant(record.action, 'fill'));
		console.log('orderActionRecords.length=', orderActionRecords.length);
		assert(orderActionRecords.length === 20);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(1);
		console.log(
			'takerPosition.baseAssetAmount=',
			takerPosition.baseAssetAmount.toString()
		);
		console.log(
			'takerPosition.quoteAssetAmount=',
			takerPosition.quoteAssetAmount.toString()
		);
		assert(takerPosition.baseAssetAmount.eq(new BN('-402388600000')));
		assert(takerPosition.quoteAssetAmount.eq(new BN('273539365')));

		const makerPosition = makerDriftClient.getUser().getPerpPosition(1);
		console.log(
			'makerPosition.baseAssetAmount=',
			makerPosition.baseAssetAmount.toString()
		);
		console.log(
			'makerPosition.quoteAssetAmount=',
			makerPosition.quoteAssetAmount.toString()
		);
		assert(makerPosition.baseAssetAmount.eq(new BN('1000000000')));
		assert(makerPosition.quoteAssetAmount.eq(new BN('-689862')));

		const secondMakerPosition = secondMakerDriftClient
			.getUser()
			.getPerpPosition(1);
		console.log(
			'secondMakerPosition.baseAssetAmount=',
			secondMakerPosition.baseAssetAmount.toString()
		);
		console.log(
			'secondMakerPosition.quoteAssetAmount=',
			secondMakerPosition.quoteAssetAmount.toString()
		);
		assert(secondMakerPosition.baseAssetAmount.eq(new BN('3000000000')));
		assert(secondMakerPosition.quoteAssetAmount.eq(new BN('-2063588')));

		const thirdMakerPosition = thirdMakerDriftClient
			.getUser()
			.getPerpPosition(1);
		console.log(
			'thirdMakerPosition.baseAssetAmount=',
			thirdMakerPosition.baseAssetAmount.toString()
		);
		console.log(
			'thirdMakerPosition.quoteAssetAmount=',
			thirdMakerPosition.quoteAssetAmount.toString()
		);
		assert(thirdMakerPosition.baseAssetAmount.eq(new BN('3000000000')));
		assert(thirdMakerPosition.quoteAssetAmount.eq(new BN('-2063588')));

		const dogMarket = takerDriftClient.getPerpMarketAccount(1);
		console.log(
			'dogMarket.amm.baseAssetAmountWithAmm=',
			dogMarket.amm.baseAssetAmountWithAmm.toString()
		);
		assert(dogMarket.amm.baseAssetAmountWithAmm.eq(new BN('-395388600000')));

		// close position

		for (let i = 0; i < 3; i++) {
			await makerDriftClient.placePerpOrder({
				marketIndex: 1,
				direction: PositionDirection.SHORT,
				price: new BN((0.69 + i / 100) * PRICE_PRECISION.toNumber()),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		for (let i = 1; i < 2; i++) {
			await secondMakerDriftClient.placePerpOrder({
				marketIndex: 1,
				direction: PositionDirection.SHORT,
				price: new BN((0.69 + i / 400) * PRICE_PRECISION.toNumber()),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION.mul(new BN(100)),
			});
		}

		await setFeedPrice(anchor.workspace.Pyth, 0.75, dogUsd);
		await takerDriftClient.placePerpOrder({
			marketIndex: 1,
			orderType: OrderType.LIMIT,
			price: new BN(0.75 * PRICE_PRECISION.toNumber()),
			direction: PositionDirection.LONG,
			baseAssetAmount: takerPosition.baseAssetAmount,
		});

		const txSig2 = await fillerDriftClient.fillPerpOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(2),
			makerInfo
		);

		const takerPosition2 = takerDriftClient.getUser().getPerpPosition(1);
		console.log(
			'takerPosition2.baseAssetAmount=',
			takerPosition2.baseAssetAmount.toString()
		);
		assert(takerPosition2.baseAssetAmount.eq(new BN(0)));

		const dogMarketAfter = takerDriftClient.getPerpMarketAccount(1);
		console.log(
			'dogMarketAfter.amm.baseAssetAmountWithAmm=',
			dogMarketAfter.amm.baseAssetAmountWithAmm.toString()
		);
		assert(
			dogMarketAfter.amm.baseAssetAmountWithAmm.eq(new BN('-66279600000'))
		);

		await printTxLogs(connection, txSig2);

		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await secondMakerDriftClient.unsubscribe();
		await thirdMakerDriftClient.unsubscribe();
	});
});
