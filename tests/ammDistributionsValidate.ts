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
	OracleSource,
	PEG_PRECISION,
	BulkAccountLoader,
	calculateBidAskPrice,
	MARGIN_PRECISION,
	OrderType,
} from '../sdk/src';

import {
	createUserWithUSDCAccount,
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';

describe('amm distribution validations', () => {
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
	const mockSolPx = 20.1;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(mockSolPx);

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

		const periodicity = new BN(1); // 1 second

		await fillerDriftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(mockSolPx * PEG_PRECISION.toNumber())
		);
		await fillerDriftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerDriftClient.updatePerpMarketCurveUpdateIntensity(0, 100);
		await fillerDriftClient.updateAmmJitIntensity(0, 100);

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

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('taker long solUsd', async () => {
		const state = await fillerDriftClient.getStateAccount();
		assert(state.numberOfMarkets == 1);
		assert(state.numberOfSpotMarkets == 1);

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
		const marketIndex = 0;

		const perpMarket = fillerDriftClient.getPerpMarketAccount(marketIndex);
		console.log(perpMarket);

		const [bid, ask] = calculateBidAskPrice(
			perpMarket.amm,
			fillerDriftClient.getOracleDataForPerpMarket(marketIndex)
		);
		console.log('bid:', bid.toString());
		console.log('ask:', ask.toString());

		// const uu = await takerDriftClient.getSpotPosition(0);
		// const uu2 = await takerDriftClient.getSpotPosition(1);
		// console.log(uu);
		// console.log(uu2);

		const takerBaseAssetAmount = new BN(6).mul(BASE_PRECISION);
		const txSig = await takerDriftClient.placeAndTakePerpOrder({
			marketIndex: 0,
			orderType: OrderType.LIMIT,
			price: new BN(24).mul(PRICE_PRECISION),
			direction: PositionDirection.LONG,
			baseAssetAmount: takerBaseAssetAmount,
		});

		await printTxLogs(connection, txSig);

		const takerPosition = takerDriftClient.getUser().getPerpPosition(0);
		assert(takerPosition.baseAssetAmount.eq(takerBaseAssetAmount));
		// assert(takerPosition.quoteAssetAmount.eq(new BN(-576576000))); //todo
	});
});
