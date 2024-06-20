import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	mockOracleNoProgram,
	setFeedPriceNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	getFeedDataNoProgram,
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
} from '../sdk/src';
import { startAnchor } from "solana-bankrun";
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('User Account', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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
		const context = await startAnchor("", [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

		
		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, bankrunContextWrapper);

		solUsdOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			initialSOLPrice,
			-10,
			0.0005
		);

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
			oracleInfos: [{ publicKey: solUsdOracle, source: OracleSource.PYTH }],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
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
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			convertToNumber(reservePrice.sub(new BN(250))),
			solUsdOracle
		);
		await sleep(5000);

		await driftClient.fetchAccounts();
		const oracleP2 = await getFeedDataNoProgram(bankrunContextWrapper.connection, solUsdOracle);
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
		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			convertToNumber(reservePrice.sub(new BN(275))),
			solUsdOracle
		);
		await sleep(5000);

		await driftClient.fetchAccounts();
		const oracleP2 = await getFeedDataNoProgram(bankrunContextWrapper.connection, solUsdOracle);
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
		const expectedTotalCollateral = new BN(20000000);
		const expectedBuyingPower = new BN(45000280);
		const expectedFreeCollateral = new BN(9000056);
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

		const expectedBuyingPower = new BN(100000000);
		const expectedFreeCollateral = new BN(20000000);
		const expectedPNL = new BN(4894473);
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
});
