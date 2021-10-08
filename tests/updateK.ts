import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';
import { AMM_MANTISSA, ClearingHouse, stripMantissa } from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import { mockUSDCMint } from '../utils/mockAccounts';

describe('update k', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let usdcMint;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
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
			periodicity
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Successful update k', async () => {
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
			stripMantissa(ammInitialBaseAssetReserve),
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

	// TODO: write updateK when base/quote imbalanced

	// it('update k error', async () => {
	//     const newBaseAssetReserve = ammInitialBaseAssetReserve.mul(new BN(100));
	//     const newQuoteAssetReserve = ammInitialQuoteAssetReserve.mul(new BN(10));

	//     try {
	//         await clearingHouse.updateK(
	//             newSqrtK,
	//             Markets[0].marketIndex,
	//         );
	//     } catch (e) {
	//         assert(true);
	//         return;
	//     }
	//     assert(false);
	// });
});
