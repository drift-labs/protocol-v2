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
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
} from './testHelpers';
import { MARGIN_PRECISION, OrderType, SpotOperation } from '../sdk/src';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ContractTier } from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('multiple maker orders', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 100);
		dogUsd = await mockOracleNoProgram(bankrunContextWrapper, 0.6899, -4, 0);

		marketIndexes = [0, 1];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new TestClient({
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
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(fillerDriftClient, solUsd);
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
			ContractTier.A,
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

		const oneSol = new BN(LAMPORTS_PER_SOL);
		try {
			await fillerDriftClient.deposit(
				oneSol.muln(100),
				1,
				bankrunContextWrapper.provider.wallet.publicKey
			);
		} catch (e) {
			console.error(e);
		}

		await fillerDriftClient.updateSpotMarketPausedOperations(
			1,
			SpotOperation.UPDATE_CUMULATIVE_INTEREST
		);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('taker long solUsd', async () => {
		const [takerDriftClient, takerUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await takerDriftClient.updateUserMarginTradingEnabled([
			{
				marginTradingEnabled: true,
				subAccountId: 0,
			},
		]);

		await takerDriftClient.deposit(usdcAmount, 0, takerUSDCAccount);

		const [makerDriftClient, makerUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await makerDriftClient.deposit(usdcAmount, 0, makerUSDCAccount);

		await makerDriftClient.updateUserMarginTradingEnabled([
			{
				marginTradingEnabled: true,
				subAccountId: 0,
			},
		]);

		for (let i = 0; i < 6; i++) {
			await makerDriftClient.placeSpotOrder({
				marketIndex: 1,
				direction: PositionDirection.SHORT,
				price: new BN(95 + i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		const [secondMakerDriftClient, secondMakerUSDCAccount] =
			await createUserWithUSDCAccount(
				bankrunContextWrapper,
				usdcMint,
				chProgram,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);

		await secondMakerDriftClient.deposit(usdcAmount, 0, secondMakerUSDCAccount);

		await secondMakerDriftClient.updateUserMarginTradingEnabled([
			{
				marginTradingEnabled: true,
				subAccountId: 0,
			},
		]);

		for (let i = 0; i < 6; i++) {
			await secondMakerDriftClient.placeSpotOrder({
				marketIndex: 1,
				direction: PositionDirection.SHORT,
				price: new BN(95 + i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		const takerBaseAssetAmount = new BN(6).mul(BASE_PRECISION);
		await takerDriftClient.placeSpotOrder({
			marketIndex: 1,
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
		const txSig = await fillerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(1),
			null,
			makerInfo,
			null,
			{
				computeUnits: 1400000,
			}
		);

		bankrunContextWrapper.printTxLogs(txSig);

		const orderActionRecords = eventSubscriber
			.getEventsArray('OrderActionRecord')
			.filter((record) => isVariant(record.action, 'fill'));
		assert(orderActionRecords.length === 6);

		const takerQuoteAmount = takerDriftClient.getUser().getTokenAmount(0);
		const takerBaseAmount = takerDriftClient.getUser().getTokenAmount(1);
		assert(takerBaseAmount.eq(new BN(6000000000)));
		assert(takerQuoteAmount.eq(new BN(99423424000)));

		const makerQuoteAmount = makerDriftClient.getUser().getTokenAmount(0);
		const makerBaseAmount = makerDriftClient.getUser().getTokenAmount(1);
		assert(makerBaseAmount.eq(new BN(-3000000003)));
		assert(makerQuoteAmount.eq(new BN(100288057600)));

		const secondMakerQuoteAmount = secondMakerDriftClient
			.getUser()
			.getTokenAmount(0);
		const secondMakerBaseAmount = secondMakerDriftClient
			.getUser()
			.getTokenAmount(1);
		assert(secondMakerBaseAmount.eq(new BN(-3000000003)));
		assert(secondMakerQuoteAmount.eq(new BN(100288057600)));

		for (let i = 0; i < 3; i++) {
			await makerDriftClient.placeSpotOrder({
				marketIndex: 1,
				direction: PositionDirection.LONG,
				price: new BN(101 - i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		console.log('here');

		for (let i = 0; i < 3; i++) {
			await secondMakerDriftClient.placeSpotOrder({
				marketIndex: 1,
				direction: PositionDirection.LONG,
				price: new BN(101 - i).mul(PRICE_PRECISION),
				orderType: OrderType.LIMIT,
				baseAssetAmount: BASE_PRECISION,
			});
		}

		console.log('here2');

		await setFeedPriceNoProgram(bankrunContextWrapper, 90, solUsd);
		await takerDriftClient.placeSpotOrder({
			marketIndex: 1,
			orderType: OrderType.LIMIT,
			price: new BN(90).mul(PRICE_PRECISION),
			direction: PositionDirection.SHORT,
			baseAssetAmount: takerBaseAssetAmount,
		});

		console.log('here3');

		await fillerDriftClient.fetchAccounts();

		const txSig2 = await fillerDriftClient.fillSpotOrder(
			await takerDriftClient.getUserAccountPublicKey(),
			takerDriftClient.getUserAccount(),
			takerDriftClient.getOrder(2),
			null,
			makerInfo,
			null,
			{
				computeUnits: 1400000,
			}
		);
		bankrunContextWrapper.printTxLogs(txSig2);

		const takerPosition2 = takerDriftClient.getUser().getTokenAmount(1);
		console.log(takerPosition2.toString());
		assert(takerPosition2.eq(new BN(0)));

		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await secondMakerDriftClient.unsubscribe();
	});
});
