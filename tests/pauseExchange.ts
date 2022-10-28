import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, QUOTE_SPOT_MARKET_INDEX } from '../sdk';

import { Program } from '@project-serum/anchor';

import { AdminClient, PRICE_PRECISION, PositionDirection } from '../sdk/src';

import { mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

describe('admin withdraw', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const driftProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
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

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		const solUsd = anchor.web3.Keypair.generate();
		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializeMarket(
			solUsd.publicKey,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = 0;
		const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
		await driftClient.openPosition(
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('Pause exchange', async () => {
		await driftClient.updateExchangePaused(true);
		const state = driftClient.getStateAccount();
		assert(state.exchangePaused);
	});

	it('Block open position', async () => {
		try {
			await driftClient.openPosition(PositionDirection.LONG, usdcAmount, 0);
		} catch (e) {
			assert(e.msg, 'Exchange is paused');
			return;
		}
		console.assert(false);
	});

	it('Block close position', async () => {
		try {
			await driftClient.closePosition(0);
		} catch (e) {
			assert(e.msg, 'Exchange is paused');
			return;
		}
		console.assert(false);
	});

	it('Block withdrawal', async () => {
		try {
			await driftClient.withdraw(
				usdcAmount,
				QUOTE_SPOT_MARKET_INDEX,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			assert(e.msg, 'Exchange is paused');
			return;
		}
		console.assert(false);
	});
});
