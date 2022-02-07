import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import {
	Admin,
	MARK_PRICE_PRECISION,
	MAX_LEVERAGE,
	PositionDirection,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

const calculateTradeAmount = (amountOfCollateral: BN) => {
	const ONE_MANTISSA = new BN(100000);
	const fee = ONE_MANTISSA.div(new BN(1000));
	const tradeAmount = amountOfCollateral
		.mul(MAX_LEVERAGE)
		.mul(ONE_MANTISSA.sub(MAX_LEVERAGE.mul(fee)))
		.div(ONE_MANTISSA);
	return tradeAmount;
};

describe('admin withdraw', () => {
	const provider = anchor.Provider.local();
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
	const fee = new BN(49750);

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

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		const incrementalUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			incrementalUSDCNotionalAmount,
			marketIndex
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('Try to withdraw too much', async () => {
		const withdrawAmount = fee.div(new BN(2)).add(new BN(1));
		try {
			await clearingHouse.withdrawFees(
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
		const withdrawAmount = fee.div(new BN(2));
		const state = await clearingHouse.getStateAccount();
		await clearingHouse.withdrawFees(
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
		const withdrawAmount = fee.div(new BN(4));
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
		const withdrawAmount = fee.div(new BN(4));

		let market = clearingHouse.getMarketsAccount().markets[0];
		assert(market.amm.totalFee.eq(fee));

		await clearingHouse.withdrawFromInsuranceVaultToMarket(
			new BN(0),
			withdrawAmount
		);
		const clearingHouseState = clearingHouse.getStateAccount();
		const collateralVaultTokenAccount = await getTokenAccount(
			provider,
			clearingHouseState.collateralVault
		);
		assert(collateralVaultTokenAccount.amount.eq(new BN(9987562)));

		market = clearingHouse.getMarketsAccount().markets[0];

		// deposits go entirely to distributions for sym-funding/repeg/k-adjustments
		console.log(market.amm.totalFee.toString());
		console.log(market.amm.totalFeeMinusDistributions.toString());
		assert(market.amm.totalFee.lt(market.amm.totalFeeMinusDistributions));
		assert(market.amm.totalFeeMinusDistributions.eq(new BN(62187)));
	});
});
