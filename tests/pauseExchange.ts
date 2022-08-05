import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, QUOTE_ASSET_BANK_INDEX } from '../sdk';

import { Program } from '@project-serum/anchor';

import { Admin, MARK_PRICE_PRECISION, PositionDirection } from '../sdk/src';

import { mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

describe('admin withdraw', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
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

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const solUsd = anchor.web3.Keypair.generate();
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd.publicKey,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Pause exchange', async () => {
		await clearingHouse.updateExchangePaused(true);
		const state = clearingHouse.getStateAccount();
		assert(state.exchangePaused);
	});

	it('Block open position', async () => {
		try {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				usdcAmount,
				new BN(0)
			);
		} catch (e) {
			assert(e.msg, 'Exchange is paused');
			return;
		}
		console.assert(false);
	});

	it('Block close position', async () => {
		try {
			await clearingHouse.closePosition(new BN(0));
		} catch (e) {
			assert(e.msg, 'Exchange is paused');
			return;
		}
		console.assert(false);
	});

	it('Block withdrawal', async () => {
		try {
			await clearingHouse.withdraw(
				usdcAmount,
				QUOTE_ASSET_BANK_INDEX,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			assert(e.msg, 'Exchange is paused');
			return;
		}
		console.assert(false);
	});
});
