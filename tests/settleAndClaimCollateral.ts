import * as anchor from '@project-serum/anchor';
import {
	BN,
	ClearingHouseUser,
	MARK_PRICE_PRECISION,
	Markets,
} from '../sdk/src';
import { assert } from 'chai';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import { Admin, ClearingHouse } from '../sdk/src';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { PositionDirection, ZERO } from '../sdk';

describe('settle and claim collateral', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;
	let primaryClearingHouse: Admin;

	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	it('settle and claim collateral', async () => {
		usdcMint = await mockUSDCMint(provider);

		primaryClearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await primaryClearingHouse.initialize(usdcMint.publicKey, true);

		await primaryClearingHouse.subscribe();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		const createUser = async (): Promise<
			[ClearingHouse, ClearingHouseUser, PublicKey]
		> => {
			const userKeyPair = new Keypair();
			await provider.connection.requestAirdrop(userKeyPair.publicKey, 10 ** 9);
			const userUSDCAccount = await mockUserUSDCAccount(
				usdcMint,
				usdcAmount,
				provider,
				userKeyPair.publicKey
			);
			const clearingHouse = ClearingHouse.from(
				connection,
				new Wallet(userKeyPair),
				chProgram.programId,
				{
					commitment: 'confirmed',
				}
			);
			await clearingHouse.subscribe();
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

			const clearingHouseUser = ClearingHouseUser.from(
				clearingHouse,
				userKeyPair.publicKey
			);
			await clearingHouseUser.subscribe();

			return [clearingHouse, clearingHouseUser, userUSDCAccount.publicKey];
		};

		const [
			firstClearingHouse,
			firstClearingHouseUser,
			firstUSDCTokenAccountPublicKey,
		] = await createUser();
		const [
			secondClearingHouse,
			secondClearingHouseUser,
			secondUSDCTokenAccountPublicKey,
		] = await createUser();
		const [
			thirdClearingHouse,
			thirdClearingHouseUser,
			thirdUSDCTokenAccountPublicKey,
		] = await createUser();

		await secondClearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			new BN(0)
		);

		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve.div(new BN(10)),
			ammInitialQuoteAssetReserve,
			new BN(0)
		);

		await primaryClearingHouse.fetchAccounts();

		await primaryClearingHouse.adminUpdateUserForgoSettlement(
			firstClearingHouseUser.authority
		);

		await firstClearingHouseUser.fetchAccounts();
		assert(
			firstClearingHouseUser.getUserAccount().forgoPositionSettlement === 1
		);

		await primaryClearingHouse.initializeSettlementState();
		let settlementState = await primaryClearingHouse.getSettlementAccount();
		assert(settlementState.collateralClaimed.eq(ZERO));
		assert(
			settlementState.collateralAvailableToClaim.eq(usdcAmount.mul(new BN(3)))
		);
		assert(settlementState.totalSettlementValue.eq(new BN(46244321)));
		assert(!settlementState.enabled);

		await primaryClearingHouse.updateSettlementStateEnabled(true);

		try {
			await firstClearingHouse.settlePositionAndClaimCollateral(
				firstUSDCTokenAccountPublicKey
			);
			assert(false);
		} catch (e) {
			//should throw err
		}

		assert(secondClearingHouseUser.getUserAccount().hasSettledPosition === 0);
		let expectedCollateralClaimed =
			secondClearingHouseUser.getClaimableCollateral(settlementState);
		await secondClearingHouse.settlePositionAndClaimCollateral(
			secondUSDCTokenAccountPublicKey
		);

		await secondClearingHouseUser.fetchAccounts();
		assert(
			secondClearingHouseUser
				.getUserAccount()
				.collateralClaimed.eq(expectedCollateralClaimed)
		);
		assert(
			secondClearingHouseUser
				.getUserAccount()
				.lastCollateralAvailableToClaim.eq(
					settlementState.collateralAvailableToClaim
				)
		);
		assert(secondClearingHouseUser.getUserAccount().hasSettledPosition === 1);

		const secondUSDCTokenAccountBalance =
			await provider.connection.getTokenAccountBalance(
				secondUSDCTokenAccountPublicKey
			);
		assert(
			new BN(secondUSDCTokenAccountBalance.value.amount).eq(
				expectedCollateralClaimed
			)
		);

		settlementState = await primaryClearingHouse.getSettlementAccount();
		assert(settlementState.collateralClaimed.eq(expectedCollateralClaimed));

		expectedCollateralClaimed =
			thirdClearingHouseUser.getClaimableCollateral(settlementState);
		await thirdClearingHouse.settlePositionAndClaimCollateral(
			thirdUSDCTokenAccountPublicKey
		);

		await thirdClearingHouse.fetchAccounts();
		assert(
			thirdClearingHouseUser
				.getUserAccount()
				.collateralClaimed.eq(expectedCollateralClaimed)
		);
		assert(
			thirdClearingHouseUser
				.getUserAccount()
				.lastCollateralAvailableToClaim.eq(
					settlementState.collateralAvailableToClaim
				)
		);

		const thirdUSDCTokenAccountBalance =
			await provider.connection.getTokenAccountBalance(
				thirdUSDCTokenAccountPublicKey
			);
		assert(
			new BN(thirdUSDCTokenAccountBalance.value.amount).eq(
				expectedCollateralClaimed
			)
		);

		await primaryClearingHouse.unsubscribe();
		await firstClearingHouse.unsubscribe();
		await firstClearingHouseUser.unsubscribe();
		await secondClearingHouse.unsubscribe();
		await secondClearingHouseUser.unsubscribe();
		await thirdClearingHouse.unsubscribe();
		await thirdClearingHouseUser.unsubscribe();
	});
});
