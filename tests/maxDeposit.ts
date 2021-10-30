import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { AMM_MANTISSA, ClearingHouse } from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

describe('max deposit', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: ClearingHouse;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

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

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.updateMaxDeposit(usdcAmount.div(new BN(2)));
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('successful deposit', async () => {
		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount.div(new BN(2)),
				userUSDCAccount.publicKey
			);
	});

	it('blocked deposit', async () => {
		try {
			await clearingHouse.depositCollateral(
				usdcAmount.div(new BN(2)),
				userUSDCAccount.publicKey
			);
		} catch (e) {
			return;
		}
		assert(false);
	});
});
