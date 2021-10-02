import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey } from '@solana/web3.js';

import {
    AMM_MANTISSA,
    ClearingHouse,
    UserAccount,
    PositionDirection,
} from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
    mockUSDCMint,
    mockUserUSDCAccount,
} from '../utils/mockAccounts';

describe('admin withdraw', () => {
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
    const fee = new BN(2500);

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
            periodicity
        );

        [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        const marketIndex = new BN(0);
        const incrementalUSDCNotionalAmount = usdcAmount.mul(new BN(5));
        await clearingHouse.openPosition(
            userAccountPublicKey,
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
            await clearingHouse.withdrawFees(withdrawAmount, userUSDCAccount.publicKey);
        } catch (e) {
            return;
        }
        assert(false, "Withdraw Successful");
    });

    it('Withdraw Fees', async () => {
        const withdrawAmount = fee.div(new BN(2));
        const state = await clearingHouse.getState();
        await clearingHouse.withdrawFees(withdrawAmount, state.insuranceVault);
        const insuranceVaultAccount = await getTokenAccount(provider, state.insuranceVault);
        assert(insuranceVaultAccount.amount.eq(withdrawAmount));
    });

    it('Withdraw From Insurance Vault', async () => {
        const withdrawAmount = fee.div(new BN(2));
        await clearingHouse.withdrawFromInsuranceVault(withdrawAmount, userUSDCAccount.publicKey);
        const userUSDCTokenAccount = await getTokenAccount(provider, userUSDCAccount.publicKey);
        assert(userUSDCTokenAccount.amount.eq(withdrawAmount));
    });
});