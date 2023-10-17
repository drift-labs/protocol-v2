import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	createPriceFeed,
	setFeedPrice,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	getFeedData,
	sleep,
} from './testHelpers';
import { Keypair } from '@solana/web3.js';
import { assert } from 'chai';
import {
	TestClient,
	User,
	PEG_PRECISION,
	MAX_LEVERAGE,
	PositionDirection,
	QUOTE_SPOT_MARKET_INDEX,
	MarketStatus,
	BASE_PRECISION,
	BN,
	OracleSource,
	calculateWorstCaseBaseAssetAmount,
	calculateMarketMarginRatio,
	calculateReservePrice,
	convertToNumber,
	calculatePrice,
	AMM_RESERVE_PRECISION,
	MarketType,
} from '../sdk/src';
import { BulkAccountLoader } from '../sdk';

describe('User Account', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	const ammInitialQuoteAssetAmount = new anchor.BN(2 * 10 ** 9).mul(
		new BN(10 ** 5)
	);
	const ammInitialBaseAssetAmount = new anchor.BN(2 * 10 ** 9).mul(
		new BN(10 ** 5)
	);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = 0;
	const initialSOLPrice = 50;

	const usdcAmount = new BN(20 * 10 ** 6);
	let userAccount: User;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
			confidence: 0.0005,
			expo: -10,
		});

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
			oracleInfos: [{ publicKey: solUsdOracle, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize();
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(0);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			0,
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(initialSOLPrice).mul(PEG_PRECISION)
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await driftClient.initializeUserAccount();
		userAccount = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await userAccount.unsubscribe();
	});

	const assertState = async (
		expectedBuyingPower: BN,
		expectedFreeCollateral: BN,
		expectedPNL: BN,
		expectedTotalCollateral: BN,
		expectedLeverage: BN,
		expectedMarginRatio: BN
	) => {
		// todo: dont hate me
		await userAccount.fetchAccounts();

		const totalCollateral = userAccount.getTotalCollateral();
		console.log(
			'totalCollateral',
			totalCollateral.toNumber(),
			expectedTotalCollateral.toNumber()
		);

		const pnl = userAccount.getUnrealizedPNL(false);
		console.log('pnl', pnl.toNumber(), expectedPNL.toNumber());
		const freeCollateral = userAccount.getFreeCollateral();
		console.log(
			'freeCollateral',
			freeCollateral.toNumber(),
			expectedFreeCollateral.toNumber()
		);
		const leverage = userAccount.getLeverage();
		console.log('leverage', leverage.toNumber(), expectedLeverage.toNumber());
		const marginRatio = userAccount.getMarginRatio();
		console.log(
			'marginRatio',
			marginRatio.toNumber(),
			expectedMarginRatio.toNumber()
		);

		const buyingPower = userAccount.getPerpBuyingPower(0);
		console.log(
			'buyingPower',
			buyingPower.toNumber(),
			expectedBuyingPower.toNumber()
		);

		assert(pnl.eq(expectedPNL));
		assert(buyingPower.eq(expectedBuyingPower));
		assert(marginRatio.eq(expectedMarginRatio));
		assert(totalCollateral.eq(expectedTotalCollateral));
		assert(leverage.eq(expectedLeverage));
		assert(freeCollateral.eq(expectedFreeCollateral));
	};

	it('Before Deposit', async () => {
		const expectedBuyingPower = new BN(0);
		const expectedFreeCollateral = new BN(0);
		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(0);
		const expectedLeverage = new BN(0);
		const expectedMarginRatio = new BN(Number.MAX_SAFE_INTEGER);

		await assertState(
			expectedBuyingPower,
			expectedFreeCollateral,
			expectedPNL,
			expectedTotalCollateral,
			expectedLeverage,
			expectedMarginRatio
		);
	});

	it('After Deposit', async () => {
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		const expectedBuyingPower = new BN(usdcAmount).mul(MAX_LEVERAGE);
		const expectedFreeCollateral = new BN(20000000);
		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(20000000);
		const expectedLeverage = new BN(0);
		const expectedMarginRatio = new BN(Number.MAX_SAFE_INTEGER);

		await assertState(
			expectedBuyingPower,
			expectedFreeCollateral,
			expectedPNL,
			expectedTotalCollateral,
			expectedLeverage,
			expectedMarginRatio
		);
	});

	it('After Position Taken', async () => {
		await driftClient.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);
		await driftClient.fetchAccounts();
		await userAccount.fetchAccounts();
		const perpPosition = userAccount.getPerpPosition(marketIndex);

		const market = driftClient.getPerpMarketAccount(perpPosition.marketIndex);

		const oraclePrice = driftClient.getOracleDataForPerpMarket(
			market.marketIndex
		).price;
		const reservePrice = calculatePrice(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);
		console.log(
			'mark vs oracle price:',
			convertToNumber(reservePrice),
			convertToNumber(oraclePrice)
		);
		await setFeedPrice(
			anchor.workspace.Pyth,
			convertToNumber(reservePrice.sub(new BN(250))),
			solUsdOracle
		);
		await sleep(5000);

		await driftClient.fetchAccounts();
		const oracleP2 = await getFeedData(anchor.workspace.Pyth, solUsdOracle);
		console.log('oracleP2:', oracleP2.price);
		const oraclePrice2 = driftClient.getOracleDataForPerpMarket(
			market.marketIndex
		).price;
		const reservePrice2 = calculateReservePrice(market, oraclePrice);
		console.log(
			'mark2 vs oracle2 price:',
			convertToNumber(reservePrice2),
			convertToNumber(oraclePrice2)
		);

		const worstCaseBaseAssetAmount =
			calculateWorstCaseBaseAssetAmount(perpPosition);

		const worstCaseAssetValue = worstCaseBaseAssetAmount
			.abs()
			.mul(oraclePrice)
			.div(AMM_RESERVE_PRECISION);

		console.log('worstCaseAssetValue:', worstCaseAssetValue.toNumber());

		const marketMarginRatio = calculateMarketMarginRatio(
			market,
			MarketType.PERP,
			worstCaseBaseAssetAmount.abs(),
			'Maintenance'
		);

		console.log('marketMarginRatio:', marketMarginRatio);

		const expectedPNL = new BN(-50002);
		const expectedTotalCollateral = new BN(19949998);
		const expectedBuyingPower = new BN(49749740);
		const expectedFreeCollateral = new BN(9949948);
		const expectedLeverage = new BN(25062);
		const expectedMarginRatio = new BN(3989);

		await assertState(
			expectedBuyingPower,
			expectedFreeCollateral,
			expectedPNL,
			expectedTotalCollateral,
			expectedLeverage,
			expectedMarginRatio
		);
	});

	it('After Position Price Moves', async () => {
		await driftClient.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount.mul(new BN(11)).div(new BN(10))
		);
		const perpPosition = userAccount.getPerpPosition(marketIndex);

		const market = driftClient.getPerpMarketAccount(perpPosition.marketIndex);

		const oraclePrice = driftClient.getOracleDataForPerpMarket(
			market.marketIndex
		).price;
		const reservePrice = calculatePrice(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);

		console.log(
			'mark vs oracle price:',
			convertToNumber(reservePrice),
			convertToNumber(oraclePrice)
		);
		await setFeedPrice(
			anchor.workspace.Pyth,
			convertToNumber(reservePrice.sub(new BN(275))),
			solUsdOracle
		);
		await sleep(5000);

		await driftClient.fetchAccounts();
		const oracleP2 = await getFeedData(anchor.workspace.Pyth, solUsdOracle);
		console.log('oracleP2:', oracleP2.price);
		const oraclePrice2 = driftClient.getOracleDataForPerpMarket(
			market.marketIndex
		).price;
		const reservePrice2 = calculateReservePrice(market, oraclePrice);
		console.log(
			'mark2 vs oracle2 price:',
			convertToNumber(reservePrice2),
			convertToNumber(oraclePrice2)
		);

		const expectedPNL = new BN(4949472);
		const expectedTotalCollateral = new BN(24949472);
		const expectedBuyingPower = new BN(69747640);
		const expectedFreeCollateral = new BN(13949528);
		const expectedLeverage = new BN(22044);
		const expectedMarginRatio = new BN(4536);

		await assertState(
			expectedBuyingPower,
			expectedFreeCollateral,
			expectedPNL,
			expectedTotalCollateral,
			expectedLeverage,
			expectedMarginRatio
		);
	});
	it('Close Position', async () => {
		await driftClient.closePosition(marketIndex);

		const expectedBuyingPower = new BN(124472365);
		const expectedFreeCollateral = new BN(24894473);
		const expectedPNL = new BN(4894473);
		const expectedTotalCollateral = new BN(24894473);
		const expectedLeverage = new BN(0);
		const expectedMarginRatio = new BN(Number.MAX_SAFE_INTEGER);

		await assertState(
			expectedBuyingPower,
			expectedFreeCollateral,
			expectedPNL,
			expectedTotalCollateral,
			expectedLeverage,
			expectedMarginRatio
		);
	});
});
