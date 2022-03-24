import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { Admin, ClearingHouseUser, PEG_PRECISION } from '../sdk/src';
import { Keypair } from '@solana/web3.js';
import { BN } from '../sdk';
import { assert } from 'chai';
import { MAX_LEVERAGE, PositionDirection } from '../sdk/src';

describe('User Account', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	const clearingHouse = Admin.from(
		connection,
		provider.wallet,
		chProgram.programId
	);

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

	const ONE_MANTISSA = new BN(100000);
	const fee = ONE_MANTISSA.div(new BN(1000));
	const solPositionInitialValue = usdcAmount
		.mul(MAX_LEVERAGE)
		.mul(ONE_MANTISSA.sub(MAX_LEVERAGE.mul(fee)))
		.div(ONE_MANTISSA);
	let userAccount: ClearingHouseUser;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsdOracle,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(initialSOLPrice).mul(PEG_PRECISION)
		);

		await clearingHouse.initializeUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
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
		const buyingPower = userAccount.getBuyingPower(new BN(0));
		assert(buyingPower.eq(expectedBuyingPower));
		const pnl = userAccount.getUnrealizedPNL();
		assert(pnl.eq(expectedPNL));
		const totalCollateral = userAccount.getTotalCollateral();
		console.log(
			'totalCollateral',
			totalCollateral.toNumber(),
			expectedTotalCollateral.toNumber()
		);
		assert(totalCollateral.eq(expectedTotalCollateral));
		const freeCollateral = userAccount.getFreeCollateral();
		assert(freeCollateral.eq(expectedFreeCollateral));
		const leverage = userAccount.getLeverage();
		console.log('leverage', leverage.toNumber(), expectedLeverage.toNumber());

		assert(leverage.eq(expectedLeverage));
		const marginRatio = userAccount.getMarginRatio();
		assert(marginRatio.eq(expectedMarginRatio));
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
		await clearingHouse.depositCollateral(
			usdcAmount,
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
			solPositionInitialValue,
			marketIndex
		);

		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(19900500);
		const expectedBuyingPower = new BN(2500);
		const expectedFreeCollateral = new BN(500);
		const expectedLeverage = new BN(49998); // 5x
		const expectedMarginRatio = new BN(2000); // 20%

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

		const expectedPNL = new BN(9947821);
		const expectedTotalCollateral = new BN(29848321);
		const expectedBuyingPower = new BN(39793785);
		const expectedFreeCollateral = new BN(7958757);
		const expectedLeverage = new BN(36667);
		const expectedMarginRatio = new BN(2727);

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

		const expectedBuyingPower = new BN(148694370);
		const expectedFreeCollateral = new BN(29738874);
		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(29738874);
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
