import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { mockUSDCMint, mockUserUSDCAccount } from '../utils/mockAccounts';
import { ClearingHouse, Network } from '../sdk/src';
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
		Network.LOCAL,
		provider.wallet,
		chProgram.programId
	);

	const ammInitialQuoteAssetAmount = new anchor.BN(1 * 10 ** 12);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 10);

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
			periodicity
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

		const expectedBuyingPower = new BN(50000000);
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
		const expectedTotalCollateral = new BN(10000000);
		const expectedBuyingPower = new BN(24999375);
		const expectedFreeCollateral = new BN(4999875);
		const expectedLeverage = new BN(2500); // 2.499x
		const expectedMarginRatio = new BN(399); // 39.9%

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
		const priceIncreaseFactor = new BN(2);
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount.mul(priceIncreaseFactor),
			marketIndex
		);

		const expectedPNL = new BN(24997511);
		const expectedTotalCollateral = new BN(34997511);
		const expectedBuyingPower = new BN(124988795);
		const expectedFreeCollateral = new BN(24997759);
		const expectedLeverage = new BN(1428); // 1.428x
		const expectedMarginRatio = new BN(699); // 69.9%

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
