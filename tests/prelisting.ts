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
	OracleSource,
	getPrelaunchOraclePublicKey,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {
	BID_ASK_SPREAD_PRECISION,
	PEG_PRECISION,
	PostOnlyParams,
} from '../sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

describe('prelisting', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let adminVelocityClient: TestClient;
	let adminVelocityClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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

		prelaunchOracle = getPrelaunchOraclePublicKey(chProgram.programId, 0);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [
			{ publicKey: prelaunchOracle, source: OracleSource.Prelaunch },
		];

		adminVelocityClient = new TestClient({
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

		await adminVelocityClient.initialize(usdcMint.publicKey, true);
		await adminVelocityClient.subscribe();
		await initializeQuoteSpotMarket(adminVelocityClient, usdcMint.publicKey);

		const startPrice = PRICE_PRECISION.muln(32);
		const maxPrice = startPrice.muln(4);
		await adminVelocityClient.initializePrelaunchOracle(
			0,
			startPrice,
			maxPrice
		);

		const periodicity = new BN(3600);
		await adminVelocityClient.initializePerpMarket(
			0,
			prelaunchOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(32 * PEG_PRECISION.toNumber()),
			OracleSource.Prelaunch
		);
		await adminVelocityClient.initializeAmmCache();

		await adminVelocityClient.updatePerpMarketBaseSpread(
			0,
			Number(BID_ASK_SPREAD_PRECISION.divn(50))
		);

		await adminVelocityClient.updatePerpAuctionDuration(0);

		await adminVelocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		adminVelocityClientUser = new User({
			velocityClient: adminVelocityClient,
			userAccountPublicKey: await adminVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await adminVelocityClientUser.subscribe();
	});

	after(async () => {
		await adminVelocityClient.unsubscribe();
		await adminVelocityClientUser.unsubscribe();
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
		await adminVelocityClient.placePerpOrder(bidOrderParams);
		await adminVelocityClient.fetchAccounts();
		const bidOrder = adminVelocityClientUser.getOrderByUserOrderId(1);

		await adminVelocityClient.fillPerpOrder(
			await adminVelocityClient.getUserAccountPublicKey(),
			adminVelocityClient.getUserAccount(),
			bidOrder
		);

		// settle pnl to force oracle to update
		await adminVelocityClient.updatePrelaunchOracle(0);

		const oraclePriceDataAfterBuy =
			adminVelocityClient.getOracleDataForPerpMarket(0);
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
		await adminVelocityClient.placePerpOrder(askOrderParams);
		await adminVelocityClient.fetchAccounts();
		const askOrder = adminVelocityClientUser.getOrderByUserOrderId(1);

		await adminVelocityClient.fillPerpOrder(
			await adminVelocityClient.getUserAccountPublicKey(),
			adminVelocityClient.getUserAccount(),
			askOrder
		);

		// settle pnl to force oracle to update
		await adminVelocityClient.updatePrelaunchOracle(0);

		const oraclePriceDataAfterSell =
			adminVelocityClient.getOracleDataForPerpMarket(0);
		const oraclePriceAfterSell = oraclePriceDataAfterSell.price;
		assert(oraclePriceAfterSell.lt(oraclePriceAfterBuy));
	});

	it('update params', async () => {
		const newPrice = PRICE_PRECISION.muln(40);
		const maxPrice = newPrice.muln(4);
		await adminVelocityClient.updatePrelaunchOracleParams(
			0,
			newPrice,
			maxPrice
		);

		await adminVelocityClient.fetchAccounts();
		const price = adminVelocityClient.getOracleDataForPerpMarket(0);
		assert(price.price.eq(new BN(40000000)));

		const markTwap =
			adminVelocityClient.getPerpMarketAccount(0).marketStats.lastMarkPriceTwap;
		assert(markTwap.eq(new BN(40000000)));
	});

	it('delete', async () => {
		try {
			await adminVelocityClient.deletePrelaunchOracle(0);
			assert(false);
		} catch (e) {
			console.log('Delete successfully failed');
		}

		const oldOracleKey = adminVelocityClient.getPerpMarketAccount(0).oracle;

		const newOracle = await mockOracleNoProgram(bankrunContextWrapper, 40);
		await adminVelocityClient.updatePerpMarketOracle(
			0,
			newOracle,
			OracleSource.PYTH_LAZER
		);

		await adminVelocityClient.deletePrelaunchOracle(0);

		const result =
			await bankrunContextWrapper.connection.getAccountInfoAndContext(
				oldOracleKey,
				'processed'
			);

		assert(result.value === null);
	});
});
