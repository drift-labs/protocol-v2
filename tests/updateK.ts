import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Keypair } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	AMM_MANTISSA,
	ClearingHouse,
	UserAccount,
	stripMantissa,
	PEG_SCALAR,
	PositionDirection,
} from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import { mockUSDCMint, mockUserUSDCAccount } from '../utils/mockAccounts';
import { createPriceFeed, setFeedPrice } from '../utils/mockPythUtils';
import { USDC_PRECISION } from '../sdk/lib';

const ZERO = new BN(0);

describe('update k', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	const initialSOLPrice = 150;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const usdcAmount = new BN(1e9 * 10 ** 6);

	let userAccount: UserAccount;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = ClearingHouse.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const periodicity = new BN(60 * 60); // 1 HOUR

		const solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsdOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSOLPrice * PEG_SCALAR.toNumber())
		);

		await clearingHouse.initializeUserAccount();
		userAccount = UserAccount.from(clearingHouse, provider.wallet.publicKey);
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	it('increase k (FREE)', async () => {
		const marketIndex = Markets[0].marketIndex;

		const marketsOld = await clearingHouse.getMarketsAccount();
		const oldKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
		const ammOld = marketsOld.markets[0].amm;
		const newSqrtK = ammInitialBaseAssetReserve.mul(new BN(10));
		await clearingHouse.updateK(newSqrtK, marketIndex);

		const markets = await clearingHouse.getMarketsAccount();
		const newKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		const amm = markets.markets[0].amm;

		const marginOfError = new BN(100);

		console.log(
			'oldSqrtK',
			stripMantissa(ammOld.sqrtK),
			'oldKPrice:',
			stripMantissa(oldKPrice)
		);
		console.log(
			'newSqrtK',
			stripMantissa(newSqrtK),
			'newKPrice:',
			stripMantissa(newKPrice)
		);

		assert(ammOld.sqrtK.lt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));
	});

	it('increase k base/quote imbalance (FREE)', async () => {
		await clearingHouse.depositCollateral(
			await userAccount.getPublicKey(),
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = Markets[0].marketIndex;

		const marketsOld = await clearingHouse.getMarketsAccount();
		const targetPriceUp = new BN(
			initialSOLPrice * AMM_MANTISSA.toNumber() * 44.1
		);

		const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
			marketIndex,
			targetPriceUp
		);
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceUp);
		const oldKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
		const ammOld = marketsOld.markets[0].amm;

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(1.000132325235 * AMM_MANTISSA.toNumber()))
			.div(AMM_MANTISSA);
		await clearingHouse.updateK(newSqrtK, marketIndex);

		const markets = await clearingHouse.getMarketsAccount();
		const newKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		const amm = markets.markets[0].amm;

		const marginOfError = new BN(100);

		console.log(
			'oldSqrtK',
			stripMantissa(ammOld.sqrtK),
			'oldKPrice:',
			stripMantissa(oldKPrice)
		);
		console.log(
			'newSqrtK',
			stripMantissa(newSqrtK),
			'newKPrice:',
			stripMantissa(newKPrice)
		);

		assert(ammOld.sqrtK.lt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));
	});

	it('lower k position imbalance (AMM PROFIT)', async () => {
		const marketIndex = Markets[0].marketIndex;

		const targetPriceBack = new BN(initialSOLPrice * AMM_MANTISSA.toNumber());

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.LONG,
			new BN(USDC_PRECISION),
			marketIndex
		);
		console.log('$1 position taken');
		const marketsOld = await clearingHouse.getMarketsAccount();
		assert(!marketsOld.markets[0].baseAssetAmount.eq(ZERO));

		const oldKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
		const ammOld = marketsOld.markets[0].amm;
		console.log(
			'USER getTotalCollateral',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(0.5 * AMM_MANTISSA.toNumber()))
			.div(AMM_MANTISSA);
		await clearingHouse.updateK(newSqrtK, marketIndex);
		const marketsKChange = await clearingHouse.getMarketsAccount();
		const ammKChange = marketsKChange.markets[0].amm;

		const newKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		console.log('$1 position closing');

		await clearingHouse.closePosition(
			await userAccount.getPublicKey(),
			marketIndex
		);
		console.log('$1 position closed');

		const markets = await clearingHouse.getMarketsAccount();

		const amm = markets.markets[0].amm;

		const marginOfError = new BN(AMM_MANTISSA.div(new BN(1000))); // price change less than 3 decimal places

		console.log(
			'oldSqrtK',
			stripMantissa(ammOld.sqrtK),
			'oldKPrice:',
			stripMantissa(oldKPrice)
		);
		console.log(
			'newSqrtK',
			stripMantissa(newSqrtK),
			'newKPrice:',
			stripMantissa(newKPrice)
		);

		assert(ammOld.sqrtK.gt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));

		console.log(
			'realizedFeeOld',
			stripMantissa(ammOld.totalFeeMinusDistributions, USDC_PRECISION),
			'realizedFeePostK',
			stripMantissa(ammKChange.totalFeeMinusDistributions, USDC_PRECISION),
			'realizedFeePostClose',
			stripMantissa(amm.totalFeeMinusDistributions, USDC_PRECISION)
		);
		console.log(
			'USER getTotalCollateral',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);

		// assert(amm.totalFeeMinusDistributions.lt(ammOld.totalFeeMinusDistributions));
	});

	it('increase k position imbalance (AMM LOSS)', async () => {
		const marketIndex = Markets[0].marketIndex;
		const targetPriceBack = new BN(initialSOLPrice * AMM_MANTISSA.toNumber());

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);

		console.log('taking position');
		await clearingHouse.openPosition(
			await userAccount.getPublicKey(),
			PositionDirection.LONG,
			new BN(USDC_PRECISION).mul(new BN(30000)),
			marketIndex
		);
		console.log('$1 position taken');
		const marketsOld = await clearingHouse.getMarketsAccount();
		assert(!marketsOld.markets[0].baseAssetAmount.eq(ZERO));

		const oldKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
		const ammOld = marketsOld.markets[0].amm;
		console.log(
			'USER getTotalCollateral',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);

		const newSqrtK = ammOld.sqrtK
			.mul(new BN(1.1 * AMM_MANTISSA.toNumber()))
			.div(AMM_MANTISSA);
		await clearingHouse.updateK(newSqrtK, marketIndex);
		const marketsKChange = await clearingHouse.getMarketsAccount();
		const ammKChange = marketsKChange.markets[0].amm;
		const newKPrice =
			clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

		console.log('$1 position closing');

		await clearingHouse.closePosition(
			await userAccount.getPublicKey(),
			marketIndex
		);
		console.log('$1 position closed');

		const markets = await clearingHouse.getMarketsAccount();
		const amm = markets.markets[0].amm;

		const marginOfError = new BN(AMM_MANTISSA.div(new BN(1000))); // price change less than 3 decimal places

		console.log(
			'oldSqrtK',
			stripMantissa(ammOld.sqrtK),
			'oldKPrice:',
			stripMantissa(oldKPrice)
		);
		console.log(
			'newSqrtK',
			stripMantissa(newSqrtK),
			'newKPrice:',
			stripMantissa(newKPrice)
		);

		assert(ammOld.sqrtK.lt(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		assert(amm.sqrtK.eq(newSqrtK));

		console.log(
			'realizedFeeOld',
			stripMantissa(ammOld.totalFeeMinusDistributions, USDC_PRECISION),
			'realizedFeePostK',
			stripMantissa(ammKChange.totalFeeMinusDistributions, USDC_PRECISION),
			'realizedFeePostClose',
			stripMantissa(amm.totalFeeMinusDistributions, USDC_PRECISION)
		);

		assert(
			amm.totalFeeMinusDistributions.gt(ammOld.totalFeeMinusDistributions)
		);

		console.log(
			'USER getTotalCollateral',
			stripMantissa(userAccount.getTotalCollateral(), USDC_PRECISION)
		);
	});
});
