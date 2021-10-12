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

		clearingHouse = new ClearingHouse(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const solUsd = anchor.web3.Keypair.generate();
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd.publicKey,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSOLPrice * PEG_SCALAR.toNumber())
		);

		await clearingHouse.initializeUserAccount();
		userAccount = new UserAccount(clearingHouse, provider.wallet.publicKey);
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
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

	// it('lower k position imbalance (AMM PROFIT)', async () => {
	// 	const marketIndex = Markets[0].marketIndex;

	// 	const marketsOld = await clearingHouse.getMarketsAccount();
	// 	const targetPriceUp = (new BN(initialSOLPrice * AMM_MANTISSA.toNumber()));

	// 	const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
	// 		marketIndex,
	// 		targetPriceUp
	// 	);
	// 	console.log('taking position');
	// 	await clearingHouse.openPosition(
	// 		await userAccount.getPublicKey(),
	// 		PositionDirection.LONG,
	// 		new BN(USDC_PRECISION),
	// 		marketIndex
	// 	);
	// 	console.log('$1 position taken');

	// 	const oldKPrice =
	// 		clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);
	// 	const ammOld = marketsOld.markets[0].amm;

	// 	const newSqrtK = ammOld.sqrtK.mul(new BN(.8 * AMM_MANTISSA.toNumber())).div(AMM_MANTISSA);
	// 	await clearingHouse.updateK(newSqrtK, marketIndex);

	// 	console.log('$1 position closing');

	// 	await clearingHouse.closePosition(
	// 		await userAccount.getPublicKey(),
	// 		marketIndex
	// 	);
	// 	console.log('$1 position closed');

	// 	const markets = await clearingHouse.getMarketsAccount();
	// 	const newKPrice =
	// 		clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndex);

	// 	const amm = markets.markets[0].amm;

	// 	const marginOfError = new BN(100);

	// 	console.log(
	// 		'oldSqrtK',
	// 		stripMantissa(ammOld.sqrtK),
	// 		'oldKPrice:',
	// 		stripMantissa(oldKPrice)
	// 	);
	// 	console.log(
	// 		'newSqrtK',
	// 		stripMantissa(newSqrtK),
	// 		'newKPrice:',
	// 		stripMantissa(newKPrice)
	// 	);

	// 	assert(ammOld.sqrtK.lt(amm.sqrtK));
	// 	assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
	// 	assert(amm.sqrtK.eq(newSqrtK));
	// });
});
