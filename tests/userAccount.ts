import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import {
	createPriceFeed,
	setFeedPrice,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteAssetBank,
	getFeedData,
	sleep,
} from './testHelpers';
import { Admin, ClearingHouseUser, PEG_PRECISION } from '../sdk/src';
import { Keypair } from '@solana/web3.js';
import {
	BASE_PRECISION,
	BN,
	OracleSource,
	QUOTE_ASSET_BANK_INDEX,
	calculateWorstCaseBaseAssetAmount,
	calculateMarketMarginRatio,
	AMM_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	convertToNumber,
	calculatePrice,
} from '../sdk';
import { assert } from 'chai';
import { MAX_LEVERAGE, PositionDirection } from '../sdk/src';

describe('User Account', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse;

	const ammInitialQuoteAssetAmount = new anchor.BN(2 * 10 ** 12).mul(
		new BN(10 ** 6)
	);
	const ammInitialBaseAssetAmount = new anchor.BN(2 * 10 ** 12).mul(
		new BN(10 ** 6)
	);

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	let solUsdOracle;
	const marketIndex = new BN(0);
	const initialSOLPrice = 50;

	const usdcAmount = new BN(20 * 10 ** 6);
	let userAccount: ClearingHouseUser;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
			confidence: 0.0005,
			expo: -10,
		});

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
			oracleInfos: [{ publicKey: solUsdOracle, source: OracleSource.PYTH }],
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updateAuctionDuration(0, 0);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(initialSOLPrice).mul(PEG_PRECISION)
		);

		await clearingHouse.initializeUserAccount();
		userAccount = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
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

		const pnl = userAccount.getUnrealizedPNL();
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

		const buyingPower = userAccount.getBuyingPower(new BN(0));
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
		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_ASSET_BANK_INDEX,
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
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);
		clearingHouse.fetchAccounts();
		userAccount.fetchAccounts();
		const marketPosition = userAccount.getUserPosition(marketIndex);

		const market = clearingHouse.getMarketAccount(marketPosition.marketIndex);

		const oraclePrice = clearingHouse.getOracleDataForMarket(
			market.marketIndex
		).price;
		const markPrice = calculatePrice(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);
		console.log(
			'mark vs oracle price:',
			convertToNumber(markPrice),
			convertToNumber(oraclePrice)
		);
		await setFeedPrice(
			anchor.workspace.Pyth,
			convertToNumber(markPrice.sub(new BN(250 * 10 ** 4))),
			solUsdOracle
		);
		await sleep(5000);

		clearingHouse.fetchAccounts();
		const oracleP2 = await getFeedData(anchor.workspace.Pyth, solUsdOracle);
		console.log('oracleP2:', oracleP2.price);
		const oraclePrice2 = clearingHouse.getOracleDataForMarket(
			market.marketIndex
		).price;
		const markPrice2 = calculateMarkPrice(market, oraclePrice);
		console.log(
			'mark2 vs oracle2 price:',
			convertToNumber(markPrice2),
			convertToNumber(oraclePrice2)
		);

		const worstCaseBaseAssetAmount =
			calculateWorstCaseBaseAssetAmount(marketPosition);

		const worstCaseAssetValue = worstCaseBaseAssetAmount
			.abs()
			.mul(oraclePrice)
			.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));

		console.log('worstCaseAssetValue:', worstCaseAssetValue.toNumber());

		const marketMarginRatio = calculateMarketMarginRatio(
			market,
			worstCaseBaseAssetAmount.abs(),
			'Maintenance'
		);

		console.log('marketMarginRatio:', marketMarginRatio);

		const expectedPNL = new BN(-1);
		const expectedTotalCollateral = new BN(19949999);
		const expectedBuyingPower = new BN(49749745);
		const expectedFreeCollateral = new BN(9949949);
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
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount.mul(new BN(11)).div(new BN(10)),
			marketIndex
		);
		const marketPosition = userAccount.getUserPosition(marketIndex);

		const market = clearingHouse.getMarketAccount(marketPosition.marketIndex);

		const oraclePrice = clearingHouse.getOracleDataForMarket(
			market.marketIndex
		).price;
		const markPrice = calculatePrice(
			market.amm.baseAssetReserve,
			market.amm.quoteAssetReserve,
			market.amm.pegMultiplier
		);

		console.log(
			'mark vs oracle price:',
			convertToNumber(markPrice),
			convertToNumber(oraclePrice)
		);
		await setFeedPrice(
			anchor.workspace.Pyth,
			convertToNumber(markPrice.sub(new BN(275 * 10 ** 4))),
			solUsdOracle
		);
		await sleep(5000);

		clearingHouse.fetchAccounts();
		const oracleP2 = await getFeedData(anchor.workspace.Pyth, solUsdOracle);
		console.log('oracleP2:', oracleP2.price);
		const oraclePrice2 = clearingHouse.getOracleDataForMarket(
			market.marketIndex
		).price;
		const markPrice2 = calculateMarkPrice(market, oraclePrice);
		console.log(
			'mark2 vs oracle2 price:',
			convertToNumber(markPrice2),
			convertToNumber(oraclePrice2)
		);

		const expectedPNL = new BN(4999474);
		const expectedTotalCollateral = new BN(24949474);
		const expectedBuyingPower = new BN(69747645);
		const expectedFreeCollateral = new BN(13949529);
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
		await clearingHouse.closePosition(marketIndex);

		const expectedBuyingPower = new BN(124472375);
		const expectedFreeCollateral = new BN(24894475);
		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(24894475);
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
