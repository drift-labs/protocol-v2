import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { mockUSDCMint, mockUserUSDCAccount } from '../utils/mockAccounts';
import { ClearingHouse, PEG_SCALAR } from '../sdk/src';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { MAX_LEVERAGE, UserAccount } from '../sdk/src/userAccount';
import { assert } from 'chai';
import { createPriceFeed } from '../utils/mockPythUtils';
import { PositionDirection } from '../sdk/src';

describe('User Account', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	const clearingHouse = new ClearingHouse(
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

	const usdcAmount = new BN(10 * 10 ** 6);
	const solPositionInitialValue = usdcAmount.div(new BN(2)).mul(MAX_LEVERAGE);
	let userAccount: UserAccount;

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
			new BN(initialSOLPrice).mul(PEG_SCALAR)
		);

		await clearingHouse.initializeUserAccount();
		userAccount = new UserAccount(clearingHouse, provider.wallet.publicKey);
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
		const summary = userAccount.summary();
		console.log(summary);
		const pnl0 = userAccount.getUnrealizedPNL();

		console.log(
			'PnL',
			summary.uPnL.toNumber(),
			pnl0.toNumber(),
			expectedPNL.toNumber()
		);
		console.log(summary.buyingPower.toNumber(), expectedBuyingPower.toNumber());

		console.log(
			summary.freeCollateral.toNumber(),
			expectedFreeCollateral.toNumber()
		);

		console.log(summary.marginRatio.toNumber(), expectedMarginRatio.toNumber());
		console.log(summary.leverage.toNumber(), expectedLeverage.toNumber());

		// todo: dont hate me
		const buyingPower = userAccount.getBuyingPower();
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
			await userAccount.getPublicKey(),
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const expectedBuyingPower = new BN(10000000).mul(MAX_LEVERAGE);
		const expectedFreeCollateral = new BN(10000000);
		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(10000000);
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
			await userAccount.getPublicKey(),
			PositionDirection.LONG,
			solPositionInitialValue,
			marketIndex
		);

		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(9997500);
		const expectedBuyingPower = new BN(49975000);
		const expectedFreeCollateral = new BN(4997500);
		const expectedLeverage = new BN(50012); // 5x
		const expectedMarginRatio = new BN(1999); // 20%

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

		const expectedPNL = new BN(4999450);
		const expectedTotalCollateral = new BN(14996950);
		const expectedBuyingPower = new BN(94970050);
		const expectedFreeCollateral = new BN(9497005);
		const expectedLeverage = new BN(36673);
		const expectedMarginRatio = new BN(2726);

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
		await clearingHouse.closePosition(
			await userAccount.getPublicKey(),
			marketIndex
		);

		const expectedBuyingPower = new BN(149942010);
		const expectedFreeCollateral = new BN(14994201);
		const expectedPNL = new BN(0);
		const expectedTotalCollateral = new BN(14994201);
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
