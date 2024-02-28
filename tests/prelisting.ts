import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	PositionDirection,
	User,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource, getPrelaunchOraclePublicKey,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {BID_ASK_SPREAD_PRECISION, BulkAccountLoader, PEG_PRECISION, PostOnlyParams} from '../sdk';

describe('prelisting', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let adminDriftClient: TestClient;
	let adminDriftClientUser: User;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let prelaunchOracle;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		prelaunchOracle = getPrelaunchOraclePublicKey(chProgram.programId, 0);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: prelaunchOracle, source: OracleSource.Prelaunch }];

		adminDriftClient = new TestClient({
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

		await adminDriftClient.initialize(usdcMint.publicKey, true);
		await adminDriftClient.subscribe();
		await initializeQuoteSpotMarket(adminDriftClient, usdcMint.publicKey);

		const startPrice = PRICE_PRECISION.muln(32);
		const maxPrice = startPrice.muln(4);
		await adminDriftClient.initializePrelaunchOracle(0, startPrice, maxPrice);

		const periodicity = new BN(3600);
		await adminDriftClient.initializePerpMarket(
			0,
			prelaunchOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32 * PEG_PRECISION.toNumber()),
			OracleSource.Prelaunch,
		);

		await adminDriftClient.updatePerpMarketBaseSpread(0, BID_ASK_SPREAD_PRECISION.divn(50));

		await adminDriftClient.updatePerpAuctionDuration(0);

		await adminDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		adminDriftClientUser = new User({
			driftClient: adminDriftClient,
			userAccountPublicKey: await adminDriftClient.getUserAccountPublicKey(),
		});
		await adminDriftClientUser.subscribe();
	});

	after(async () => {
		await adminDriftClient.unsubscribe();
		await adminDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('trade', async () => {
		const marketIndex = 0;
		const baseAssetAmount = BASE_PRECISION;
		const bidOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(34).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(33).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(34).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await adminDriftClient.placePerpOrder(bidOrderParams);
		await adminDriftClient.fetchAccounts();
		const bidOrder = adminDriftClientUser.getOrderByUserOrderId(1);

		await adminDriftClient.fillPerpOrder(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), bidOrder);

		// settle pnl to force oracle to update
		await adminDriftClient.settlePNL(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), 0);

		const oraclePriceDataAfterBuy = adminDriftClient.getOracleDataForPerpMarket(0);
		const oraclePriceAfterBuy = oraclePriceDataAfterBuy.price;
		assert(oraclePriceAfterBuy.gt(new BN(32000000)));

		const askOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(30).mul(PRICE_PRECISION),
			auctionStartPrice: new BN(31).mul(PRICE_PRECISION),
			auctionEndPrice: new BN(30).mul(PRICE_PRECISION),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		await adminDriftClient.placePerpOrder(askOrderParams);
		await adminDriftClient.fetchAccounts();
		const askOrder = adminDriftClientUser.getOrderByUserOrderId(1);

		await adminDriftClient.fillPerpOrder(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), askOrder);

		// settle pnl to force oracle to update
		await adminDriftClient.settlePNL(await adminDriftClient.getUserAccountPublicKey(), adminDriftClient.getUserAccount(), 0);

		const oraclePriceDataAfterSell = adminDriftClient.getOracleDataForPerpMarket(0);
		const oraclePriceAfterSell = oraclePriceDataAfterSell.price;
		assert(oraclePriceAfterSell.lt(oraclePriceAfterBuy));
	});
});
