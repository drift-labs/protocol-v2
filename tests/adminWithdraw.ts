import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BASE_PRECISION, BN } from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { Admin, PRICE_PRECISION, PositionDirection } from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
} from './testHelpers';

describe('admin withdraw', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

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
	const fee = new BN(49750);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0)],
			userStats: true,
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.mul(new BN(5)),
			marketIndex
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Try to withdraw too much', async () => {
		const withdrawAmount = fee.div(new BN(2)).add(new BN(1));
		try {
			await clearingHouse.withdrawFromMarketToInsuranceVault(
				new BN(0),
				withdrawAmount,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			return;
		}
		assert(false, 'Withdraw Successful');
	});

	it('Withdraw Fees', async () => {
		const withdrawAmount = clearingHouse
			.getUserStats()
			.getAccount()
			.fees.totalFeePaid.div(new BN(2));
		const state = await clearingHouse.getStateAccount();
		await clearingHouse.withdrawFromMarketToInsuranceVault(
			new BN(0),
			withdrawAmount,
			state.insuranceVault
		);
		const insuranceVaultAccount = await getTokenAccount(
			provider,
			state.insuranceVault
		);
		assert(insuranceVaultAccount.amount.eq(withdrawAmount));
	});

	it('Withdraw From Insurance Vault', async () => {
		const withdrawAmount = clearingHouse
			.getUserStats()
			.getAccount()
			.fees.totalFeePaid.div(new BN(4));
		await clearingHouse.withdrawFromInsuranceVault(
			withdrawAmount,
			userUSDCAccount.publicKey
		);
		const userUSDCTokenAccount = await getTokenAccount(
			provider,
			userUSDCAccount.publicKey
		);
		assert(userUSDCTokenAccount.amount.eq(withdrawAmount));
	});

	it('Withdraw From Insurance Vault to amm', async () => {
		const withdrawAmount = clearingHouse
			.getUserStats()
			.getAccount()
			.fees.totalFeePaid.div(new BN(4));

		let market = clearingHouse.getPerpMarketAccount(0);
		assert(
			market.amm.totalFee.eq(
				clearingHouse.getUserStats().getAccount().fees.totalFeePaid
			)
		);

		await clearingHouse.withdrawFromInsuranceVaultToMarket(
			new BN(0),
			withdrawAmount
		);

		const collateralVaultTokenAccount = await getTokenAccount(
			provider,
			clearingHouse.getQuoteSpotMarketAccount().vault
		);
		assert(collateralVaultTokenAccount.amount.eq(new BN(9998750)));

		market = clearingHouse.getPerpMarketAccount(0);

		// deposits go entirely to distributions for sym-funding/repeg/k-adjustments
		console.log(market.amm.totalFee.toString());
		console.log(market.amm.totalFeeMinusDistributions.toString());
		assert(market.amm.totalFee.lt(market.amm.totalFeeMinusDistributions));
		assert(market.amm.totalFeeMinusDistributions.eq(new BN(6250)));
	});
});
