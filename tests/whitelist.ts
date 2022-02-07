import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { Admin, MARK_PRICE_PRECISION } from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

describe('whitelist', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let userAccountPublicKey: PublicKey;

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

	let whitelistMint: Token;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
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

		whitelistMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			0,
			TOKEN_PROGRAM_ID
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Assert whitelist mint null', async () => {
		const state = clearingHouse.getStateAccount();
		assert(state.whitelistMint.equals(PublicKey.default));
	});

	it('enable whitelist mint', async () => {
		await clearingHouse.updateWhitelistMint(whitelistMint.publicKey);
		const state = clearingHouse.getStateAccount();
		console.assert(state.whitelistMint.equals(whitelistMint.publicKey));
	});

	it('block initialize user', async () => {
		try {
			[, userAccountPublicKey] =
				await clearingHouse.initializeUserAccountAndDepositCollateral(
					usdcAmount,
					userUSDCAccount.publicKey
				);
		} catch (e) {
			console.log(e);
			return;
		}
		assert(false);
	});

	it('successful initialize user', async () => {
		const associatedAccountInfo =
			await whitelistMint.getOrCreateAssociatedAccountInfo(
				provider.wallet.publicKey
			);
		await whitelistMint.mintTo(
			associatedAccountInfo.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1
		);
		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
	});

	it('disable whitelist mint', async () => {
		await clearingHouse.updateWhitelistMint(PublicKey.default);
		const state = clearingHouse.getStateAccount();
		console.assert(state.whitelistMint.equals(PublicKey.default));
	});
});
