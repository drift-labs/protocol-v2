import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { Admin, MARK_PRICE_PRECISION } from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

describe('delete user', () => {
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

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Fail to delete user account', async () => {
		try {
			await clearingHouse.deleteUser();
		} catch (e) {
			return;
		}
		assert(false);
	});

	it('Successfully delete user account', async () => {
		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		let userAccountInfo = await connection.getAccountInfo(userAccountPublicKey);
		assert(userAccountInfo.lamports !== 0);

		let userPositionsAccountInfo = await connection.getAccountInfo(
			user.positions
		);
		assert(userPositionsAccountInfo.lamports !== 0);

		await clearingHouse.withdrawCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		await clearingHouse.deleteUser();

		userAccountInfo = await connection.getAccountInfo(userAccountPublicKey);
		console.assert(userAccountInfo === null);
		userPositionsAccountInfo = await connection.getAccountInfo(user.positions);
		assert(userPositionsAccountInfo === null);
	});
});
